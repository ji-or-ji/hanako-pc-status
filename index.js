/**
 * 插件生命周期：只做一件事——记心跳、判断上一班是不是崩了。
 *
 * 崩溃时这个进程直接没了，onunload 不会执行，所以只能靠"最后一次心跳的时间"
 * 反推。重启后如果发现上一班既没有干净退出的标记、断点又落在可疑区间，
 * 就写一条待提醒记录，交给 extension 在用户下一次说话时递上去。
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

const PLUGIN_VERSION = "0.2.3";

/** 每个插件实例的运行时状态：{ dataDir, timer, state } */
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

export default class PcStatusPlugin {
  async onload() {
    const ctx = this.ctx;

    try {
      const dataDir = ctx.dataDir;
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
        timer: null,
        state: {
          ...previous,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          pluginVersion: PLUGIN_VERSION,
          lastCleanExitAt: previous.lastCleanExitAt || null,
          // 本次刚判定出的崩溃要保住，不能被旧值冲掉
          lastCrash: crash || previous.lastCrash || null,
        },
      };

      writeBeat(entry);

      const timer = setInterval(() => writeBeat(entry), HEARTBEAT_INTERVAL_MS);
      // 别让心跳定时器把进程钉住不退出
      timer.unref?.();
      entry.timer = timer;

      runtimes.set(this, entry);

      if (typeof this.register === "function") {
        this.register(() => {
          const current = runtimes.get(this);
          if (current?.timer) {
            clearInterval(current.timer);
            current.timer = null;
          }
        });
      }
    } catch (err) {
      ctx.log?.warn?.(`心跳初始化失败（不影响其他功能）：${err && err.message ? err.message : err}`);
    }
  }

  onunload() {
    try {
      const entry = runtimes.get(this);
      if (entry) {
        if (entry.timer) {
          clearInterval(entry.timer);
          entry.timer = null;
        }
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
