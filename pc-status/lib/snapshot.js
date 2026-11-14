/**
 * 状态快照：给"每轮开场注入"用的近实时缓存。
 *
 * 每轮都跑一次 PowerShell 采集是不行的，一次几百毫秒到两秒，用户每说一句话
 * 都要先等这么久。所以这里后台按节拍采，注入时只读内存里最近一份；
 * 时间戳在渲染时现算，所以"现在几点"永远是准的，只有电量、负载这类会旧几十秒。
 */
import { readNetworkState } from "./network-watch.js";
import { batteryLevel, collectMachineState, readVitals, vitalsSummary } from "./system-state.js";

/** 固定节拍：真实刷新间隔由配置决定，改配置不用重启定时器 */
const TICK_MS = 5000;

export function createSnapshotter(sdk, runtime) {
  let timer = null;
  let busy = false;
  let started = false;
  let lastRefreshAt = 0;

  async function refresh(force = false) {
    if (busy) return;
    busy = true;
    try {
      const cfg = await runtime.config();
      const includeLoad = Boolean(cfg.stateInjectIncludeLoad);
      const refreshMs = Math.max(
        10000,
        (Number(cfg.stateInjectRefreshSeconds) || 30) * 1000,
        includeLoad ? 60000 : 0,
      );
      const now = Date.now();
      if (!force && lastRefreshAt && now - lastRefreshAt < refreshMs) return;
      lastRefreshAt = now;

      const next = { at: new Date().toISOString() };

      const vitals = await readVitals();
      if (vitals.ok && vitals.data) {
        next.vitals = vitals.data;
        next.power = vitalsSummary(vitals.data, cfg);
        next.level = batteryLevel(vitals.data, cfg);
      }

      next.network = readNetworkState(sdk.dataDir) || null;

      if (includeLoad) {
        const full = await collectMachineState();
        if (full.ok && full.data) next.load = full.data;
      }

      next.at = new Date().toISOString();
      runtime.state.snapshot = next;
    } catch (err) {
      await sdk.logger.debug?.(`snapshot failed: ${err?.message || err}`);
    } finally {
      busy = false;
    }
  }

  function start() {
    if (started) return;
    started = true;
    void refresh(true);
    const handle = setInterval(() => void refresh(), TICK_MS);
    handle.unref?.();
    timer = handle;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    started = false;
  }

  return { start, stop, refresh, getSnapshot: () => runtime.state.snapshot || null };
}
