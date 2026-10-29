/**
 * 网络状态监测。
 *
 * 两个用途：
 * 1. 在线↔离线切换时记一条事件，下一次工具调用就提示，不用等新会话。
 * 2. 断得比较久（超过阈值）时另外记一条，等同于「上一段工作被打断了」，
 *    在下次会话开始时提醒 agent。
 *
 * 探测刻意绕开 DNS：先直连一个固定 IP 的 TCP 端口判断基础连通，
 * 再单独查一次常用域名判断 DNS 是否正常。这样能区分「整条网络断了」
 * 和「能连 IP 但域名解析不出来」两种完全不同的故障。
 */
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export const NETWORK_STATE_FILENAME = "network-state.json";
export const PENDING_NETWORK_FILENAME = "pending-network.json";
export const PENDING_OUTAGE_FILENAME = "pending-outage.json";

/** 默认探测目标。用一个国内、体积小的地址：只看能不能拿到 HTTP 回应。 */
export const DEFAULT_PROBE_URL = "https://www.baidu.com/";

/** 连续多少次探测一致才认定状态真的变了，防抖动 */
export const CONFIRM_SAMPLES = 2;

/** 注入事件最多保留几条，防止网络反复抖动时堆积 */
export const MAX_PENDING_EVENTS = 5;

function filePath(dir, name) {
  return path.join(dir, name);
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// ── 探测 ────────────────────────────────────────────────────────────

/**
 * 探测一次。
 *
 * v1 直连 223.5.5.5:53 判 TCP、再查一次 DNS 判解析，能区分「网断了」和「能连 IP 但解析不出来」。
 * v2 的 AppHost 用 Node 权限模型把 net / dns 全关了（实测 net.connect 与 dns.lookup 都返
 * ERR_ACCESS_DENIED），所以只能走宿主放行的出站通道 ctx.network.fetch。代价是拿不到
 * 底层错误码，DNS 那一维就跟着倒了：status 与 dnsOk 同进同出，历史文案留着不删。
 *
 * 只要拿到任何 HTTP 回应（含 4xx/5xx）就算在线——能返回状态码，链路就是通的。
 */
export async function probeNetwork(fetchImpl, options = {}) {
  const url = options.url || DEFAULT_PROBE_URL;
  const timeoutMs = Number(options.timeoutMs) || 8000;
  const checkedAt = new Date().toISOString();
  const started = Date.now();

  if (typeof fetchImpl !== "function") {
    return { status: "offline", dnsOk: false, latencyMs: 0, checkedAt, target: url, detail: "no-fetch" };
  }

  try {
    const res = await fetchImpl(url, { method: "GET", timeoutMs });
    const latencyMs = Date.now() - started;
    const code = Number(res?.status) || 0;
    if (code > 0) {
      return { status: "online", dnsOk: true, latencyMs, checkedAt, target: url, detail: `http-${code}` };
    }
    return { status: "offline", dnsOk: false, latencyMs, checkedAt, target: url, detail: "no-status" };
  } catch (err) {
    return {
      status: "offline",
      dnsOk: false,
      latencyMs: Date.now() - started,
      checkedAt,
      target: url,
      detail: `fetch-failed:${err?.message ? String(err.message).slice(0, 80) : "unknown"}`,
    };
  }
}


// ── 状态与事件 ──────────────────────────────────────────────────────

export function readNetworkState(dir) {
  return readJson(filePath(dir, NETWORK_STATE_FILENAME));
}

export function writeNetworkState(dir, state) {
  return writeJson(filePath(dir, NETWORK_STATE_FILENAME), state);
}

export function readPendingEvents(dir) {
  const raw = readJson(filePath(dir, PENDING_NETWORK_FILENAME));
  return Array.isArray(raw) ? raw : [];
}

export function appendPendingEvent(dir, event) {
  const list = readPendingEvents(dir);
  list.push(event);
  return writeJson(filePath(dir, PENDING_NETWORK_FILENAME), list.slice(-MAX_PENDING_EVENTS));
}

/** 取走并清空，保证每条只提示一次 */
export function takePendingEvents(dir) {
  const file = filePath(dir, PENDING_NETWORK_FILENAME);
  const list = readPendingEvents(dir);
  if (!list.length) return [];
  try {
    unlinkSync(file);
  } catch {
    /* 删不掉下次再来 */
  }
  return list;
}

export function writePendingOutage(dir, outage) {
  return writeJson(filePath(dir, PENDING_OUTAGE_FILENAME), outage);
}

export function peekPendingOutage(dir) {
  return readJson(filePath(dir, PENDING_OUTAGE_FILENAME));
}

export function takePendingOutage(dir) {
  const file = filePath(dir, PENDING_OUTAGE_FILENAME);
  const info = readJson(file);
  if (!info) return null;
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
  return info;
}

/**
 * 把一次探测结果并进状态，判断是否发生了需要通知的变动。
 *
 * 去抖做法：新状态先记为 candidate，连续 CONFIRM_SAMPLES 次一致才确认切换。
 * 返回 { state, changed, event }
 */
export function applyProbe(prevState, probe, now = Date.now()) {
  const prev = prevState && typeof prevState === "object" ? prevState : {};
  const observed = { status: probe.status, dnsOk: probe.dnsOk };

  const base = {
    ...prev,
    lastCheckedAt: probe.checkedAt,
    latencyMs: probe.latencyMs,
    target: probe.target,
    dnsHost: probe.dnsHost || prev.dnsHost,
    detail: probe.detail,
  };

  // 首次探测，直接建立基线，不产生事件
  if (!prev.status) {
    return {
      state: { ...base, status: observed.status, dnsOk: observed.dnsOk, changedAt: new Date(now).toISOString(), offlineSince: observed.status === "offline" ? now : null },
      changed: false,
      event: null,
    };
  }

  const sameAsCurrent = prev.status === observed.status && !!prev.dnsOk === !!observed.dnsOk;
  if (sameAsCurrent) {
    return { state: { ...base, candidate: null }, changed: false, event: null };
  }

  const candidate = prev.candidate && prev.candidate.status === observed.status && !!prev.candidate.dnsOk === !!observed.dnsOk
    ? { ...prev.candidate, count: (prev.candidate.count || 1) + 1 }
    : { ...observed, count: 1 };

  if (candidate.count < CONFIRM_SAMPLES) {
    return { state: { ...base, candidate }, changed: false, event: null };
  }

  // 确认切换
  const from = { status: prev.status, dnsOk: prev.dnsOk };
  const offlineSince = prev.offlineSince || (prev.status === "offline" ? Date.parse(prev.changedAt) || now : null);
  const wentOffline = observed.status === "offline";
  const cameBack = prev.status === "offline" && observed.status === "online";
  const outageMs = cameBack && offlineSince ? now - offlineSince : null;

  const event = {
    at: new Date(now).toISOString(),
    from,
    to: observed,
    outageMs,
    latencyMs: probe.latencyMs,
  };

  return {
    state: {
      ...base,
      status: observed.status,
      dnsOk: observed.dnsOk,
      changedAt: new Date(now).toISOString(),
      offlineSince: wentOffline ? now : null,
      lastOutageMs: outageMs ?? prev.lastOutageMs ?? null,
      candidate: null,
    },
    changed: true,
    event,
  };
}
