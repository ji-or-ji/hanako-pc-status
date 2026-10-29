/**
 * 运行时状态：配置缓存、网络监测、工具调用节流。
 *
 * v1 把这些散在 index.js 与 Pi extension 里，两边各自读配置文件；
 * v2 只有一个进程、一个 ctx，所以集中成一份 runtime，hook 和工具都从这里拿。
 *
 * 两个必须记住的边界：
 * - ctx.config 要等 apply 跑完才登记，所以这里所有读取都发生在 apply 之后（工具/hook/定时器）。
 * - AppHost 关了 net / dns，网络探测只能走 ctx.network.fetch（清单里声明了 www.baidu.com）。
 */
import {
  appendPendingEvent,
  applyProbe,
  probeNetwork,
  readNetworkState,
  writeNetworkState,
  writePendingOutage,
} from "./network-watch.js";
import { readConfigFromStore } from "./settings.js";

const CONFIG_TTL_MS = 5000;
const NETWORK_TICK_MS = 10000;
const NETWORK_MIN_INTERVAL_MS = 10000;

export function createRuntime(sdk) {
  let cachedConfig = null;
  let cachedAt = 0;

  const state = {
    lastToolStartedAt: 0,
    lastInjectedAt: 0,
    networkTimer: null,
    networkStarted: false,
    networkBusy: false,
    lastNetworkCheckAt: 0,
  };

  /** 配置读得勤（每次工具返回都要看），给 5 秒缓存，够新也不至于每步一次 RPC。 */
  async function config(force = false) {
    const now = Date.now();
    if (!force && cachedConfig && now - cachedAt < CONFIG_TTL_MS) return cachedConfig;
    cachedConfig = await readConfigFromStore(sdk);
    cachedAt = now;
    return cachedConfig;
  }

  function invalidateConfig() {
    cachedConfig = null;
    cachedAt = 0;
  }

  async function checkNetwork() {
    if (state.networkBusy) return;
    state.networkBusy = true;
    try {
      const cfg = await config();
      if (!cfg.networkWatchEnabled) return;

      const intervalMs = Math.max(
        NETWORK_MIN_INTERVAL_MS,
        (Number(cfg.networkProbeIntervalSeconds) || 25) * 1000,
      );
      const now = Date.now();
      if (now - state.lastNetworkCheckAt < intervalMs) return;
      state.lastNetworkCheckAt = now;

      const prev = readNetworkState(sdk.dataDir);
      const prevAt = prev?.lastCheckedAt ? Date.parse(prev.lastCheckedAt) : null;
      // 两次探测间隔远超正常周期，说明中间系统睡过/挂起过。
      // 这种时候不能沿用旧状态算「断网时长」，否则关一晚机器会被报成断网八小时。
      const suspended = Number.isFinite(prevAt) && now - prevAt > intervalMs * 3;

      const probe = await probeNetwork(sdk.network.fetch.bind(sdk.network), {
        timeoutMs: Math.min(8000, Math.max(2000, intervalMs)),
      });

      if (suspended) {
        writeNetworkState(sdk.dataDir, {
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

      const { state: next, changed, event } = applyProbe(prev, probe);
      writeNetworkState(sdk.dataDir, next);
      if (!changed || !event) return;

      appendPendingEvent(sdk.dataDir, event);

      const thresholdMs = Math.max(1, Number(cfg.networkOutageThresholdMinutes) || 5) * 60 * 1000;
      if (event.outageMs && event.outageMs >= thresholdMs) {
        writePendingOutage(sdk.dataDir, {
          startedAt: new Date(Date.parse(event.at) - event.outageMs).toISOString(),
          endedAt: event.at,
          outageMs: event.outageMs,
          detectedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      await sdk.logger.debug?.(`network probe skipped: ${err?.message || err}`);
    } finally {
      state.networkBusy = false;
    }
  }

  /** 固定节拍轮询，真实间隔在 checkNetwork 里按配置判断，改间隔不用重启定时器。 */
  function startNetworkWatch() {
    if (state.networkStarted) return;
    state.networkStarted = true;
    void checkNetwork();
    const timer = setInterval(() => void checkNetwork(), NETWORK_TICK_MS);
    timer.unref?.();
    state.networkTimer = timer;
  }

  return { config, invalidateConfig, checkNetwork, startNetworkWatch, state };
}
