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
import net from "node:net";
import dns from "node:dns/promises";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export const NETWORK_STATE_FILENAME = "network-state.json";
export const PENDING_NETWORK_FILENAME = "pending-network.json";
export const PENDING_OUTAGE_FILENAME = "pending-outage.json";

/** 默认探测目标：阿里公共 DNS 的 TCP 53 端口，国内基本都通，15ms 左右 */
export const DEFAULT_PROBE_TARGETS = [
  { host: "223.5.5.5", port: 53 },
  { host: "180.76.198.225", port: 443 },
];

/** 用来判断 DNS 是否工作的域名。选国内站点，避免被墙的域名造成误判 */
export const DEFAULT_DNS_CHECK = "www.baidu.com";

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

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const started = Date.now();
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, "ok"));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (err) => finish(false, err?.code || "error"));
    try {
      socket.connect(port, host);
    } catch (err) {
      finish(false, err?.code || "error");
    }
  });
}

async function probeDns(host, timeoutMs = 4000) {
  const started = Date.now();
  try {
    const result = await Promise.race([
      dns.lookup(host, { family: 4 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns-timeout")), timeoutMs)),
    ]);
    return { ok: true, address: result.address, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, reason: err?.code || err?.message || "error" };
  }
}

/**
 * 探测一次。
 * 返回 { status, dnsOk, latencyMs, checkedAt, target }
 * status: "online" 基础连通正常 / "offline" 连不上
 */
export async function probeNetwork(options = {}) {
  const targets = Array.isArray(options.targets) && options.targets.length ? options.targets : DEFAULT_PROBE_TARGETS;
  const dnsHost = options.dnsCheck || DEFAULT_DNS_CHECK;
  const checkedAt = new Date().toISOString();

  let best = null;
  for (const target of targets) {
    const result = await probeTcp(target.host, target.port, options.timeoutMs || 2500);
    if (result.ok) {
      best = { target: `${target.host}:${target.port}`, latencyMs: result.ms };
      break;
    }
    if (!best) best = { target: `${target.host}:${target.port}`, latencyMs: result.ms, failed: true };
  }

  if (best?.failed) {
    return { status: "offline", dnsOk: false, latencyMs: best.latencyMs, checkedAt, target: best.target, detail: "tcp-failed" };
  }

  const dnsResult = await probeDns(dnsHost, options.dnsTimeoutMs || 4000);
  return {
    status: "online",
    dnsOk: dnsResult.ok,
    latencyMs: best.latencyMs,
    checkedAt,
    target: best.target,
    dnsHost,
    dnsMs: dnsResult.ms,
    detail: dnsResult.ok ? "ok" : `dns-${dnsResult.reason}`,
  };
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
