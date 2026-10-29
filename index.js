/**
 * 插件生命周期：心跳、崩溃判定、网络状态监测。
 *
 * 崩溃时这个进程直接没了，onunload 不会执行，所以只能靠"最后一次心跳的时间"
 * 反推。重启后如果发现上一班既没有干净退出的标记、断点又落在可疑区间，
 * 就写一条待提醒记录，交给 extension 在用户下一次说话时递上去。
 *
 * 网络也在这里盯：每隔一段时间探一次基础连通，状态变了就记一条事件
 * （下一次工具调用就提示），断得够久再额外记一条（下次会话开头提醒）。
 *
 * 注意：所有运行时状态都放在模块级 WeakMap 里，绝不挂到插件实例上。
 * Hana 在安装流程里会序列化插件实例，实例上只要有一个 Timeout 之类的活动对象，
 * JSON.stringify 就会撞上它的 _idlePrev/_idleNext 循环引用，整个安装失败。
 */
import {
  HEARTBEAT_INTERVAL_MS,
  detectPreviousCrash,
  readState,
  recordCrashInState,
  writePendingCrash,
  writeState,
} from "./lib/runtime-watch.js";
import {
  applyProbe,
  appendPendingEvent,
  probeNetwork,
  readNetworkState,
  writeNetworkState,
  writePendingOutage,
} from "./lib/network-watch.js";
import { readConfigFromFile } from "./lib/settings.js";

const PLUGIN_VERSION = "0.3.0";

/** 每个插件实例的运行时状态：{ dataDir, timer, netTimer, state, config } */
const runtimes = new WeakMap();

function writeBeat(entry) {
  try {
    entry.state.pid = process.pid;
    entry.state.startedAt = entry.state.startedAt || new Date().toISOString();
    entry.state.lastHeartbeatAt = new Date().toISOString();
    writeState(entry.dataDir, entry.state);
  } catch {
    /* 心跳写不进去就算了，不影响插件主功能 */
  }
}

/** 探一次网络，把变动记成待提示事件 */
async function checkNetwork(entry) {
  if (entry.netBusy) return;
  entry.netBusy = true;
  try {
    const prev = readNetworkState(entry.dataDir);
    const interval = Math.max(10, Number(entry.config?.networkProbeIntervalSeconds) || 25) * 1000;

    // 两次探测间隔远超正常周期，说明中间系统睡过/挂起过。
    // 这种时候不能沿用旧状态算“断网时长”，否则关一晚机器会被报成断网八小时。
    const prevAt = prev?.lastCheckedAt ? Date.parse(prev.lastCheckedAt) : null;
    const suspended = Number.isFinite(prevAt) && Date.now() - prevAt > interval * 3;

    const probe = await probeNetwork({ dnsCheck: entry.config?.networkDnsCheck });

    if (suspended) {
      // 重建基线，但不产生事件
      const now = Date.now();
      writeNetworkState(entry.dataDir, {
        ...(prev || {}),
        ...probe,
        status: probe.status,
        dnsOk: probe.dnsOk,
        changedAt: new Date(now).toISOString(),
        offlineSince: probe.status === "offline" ? now : null,
        candidate: null,
        suspendedAt: new Date(now).toISOString(),
      });
      return;
    }

    const { state, changed, event } = applyProbe(prev, probe);
    writeNetworkState(entry.dataDir, state);

    if (!changed || !event) return;

    appendPendingEvent(entry.dataDir, event);

    // 断得够久，额外记一条，等下次会话开头提醒
    const thresholdMs = Math.max(1, Number(entry.config?.networkOutageThresholdMinutes) || 5) * 60 * 1000;
    if (event.outageMs && event.outageMs >= thresholdMs) {
      writePendingOutage(entry.dataDir, {
        startedAt: new Date(Date.parse(event.at) - event.outageMs).toISOString(),
        endedAt: event.at,
        outageMs: event.outageMs,
        detectedAt: new Date().toISOString(),
      });
    }
  } catch {
    /* 探测本身失败不该影响插件 */
  } finally {
    entry.netBusy = false;
  }
}

function startNetworkTimer(entry) {
  if (!entry.config?.networkWatchEnabled) return;
  const interval = Math.max(10, Number(entry.config?.networkProbeIntervalSeconds) || 25) * 1000;
  // 启动时先探一次建立基线
  checkNetwork(entry);
  const timer = setInterval(() => checkNetwork(entry), interval);
  timer.unref?.();
  entry.netTimer = timer;
}

export default class PcStatusPlugin {
  async onload() {
    const ctx = this.ctx;

    try {
      const dataDir = ctx.dataDir;
      const config = readConfigFromFile(dataDir);
      const previous = readState(dataDir) || {};
      const crash = detectPreviousCrash(dataDir);

      if (crash) {
        writePendingCrash(dataDir, crash);
        recordCrashInState(dataDir, crash, previous);
        ctx.log?.info?.(
          `检测到上一次运行异常终止：最后心跳 ${crash.lastHeartbeatAt}，`
          + `中断 ${Math.round(crash.gapMs / 1000)} 秒后重启，已安排提醒`,
        );
      }

      const entry = {
        dataDir,
        config,
        timer: null,
        netTimer: null,
        netBusy: false,
        state: {
          ...previous,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          pluginVersion: PLUGIN_VERSION,
          lastCleanExitAt: previous.lastCleanExitAt || null,
          lastCrash: crash || previous.lastCrash || null,
        },
      };

      writeBeat(entry);

      const timer = setInterval(() => writeBeat(entry), HEARTBEAT_INTERVAL_MS);
      timer.unref?.();
      entry.timer = timer;

      runtimes.set(this, entry);
      startNetworkTimer(entry);

      if (typeof this.register === "function") {
        this.register(() => this.stopAll());
      }
    } catch (err) {
      ctx.log?.warn?.(`初始化失败（不影响其他功能）：${err && err.message ? err.message : err}`);
    }
  }

  stopAll() {
    const entry = runtimes.get(this);
    if (!entry) return;
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
    if (entry.netTimer) {
      clearInterval(entry.netTimer);
      entry.netTimer = null;
    }
  }

  onunload() {
    try {
      const entry = runtimes.get(this);
      if (entry) {
        this.stopAll();
        // 标记干净退出：下一次启动看到它，就知道不是崩溃
        entry.state.lastCleanExitAt = new Date().toISOString();
        entry.state.pid = process.pid;
        writeState(entry.dataDir, entry.state);
        runtimes.delete(this);
      }
    } catch {
      /* ignore */
    }
    this.ctx?.log?.info?.("PC Status 已卸载");
  }
}
