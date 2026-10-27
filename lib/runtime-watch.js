/**
 * 运行时存活记录。
 *
 * 为什么需要这个东西：hana-server 崩溃时不写日志，插件也随进程一起消失，
 * 崩溃那一刻什么都记不下来。所以反过来做——运行时定期写下"我还活着"的时间戳，
 * 下次启动时看这份记录的断点有多远，就知道上一班是不是死得不明不白。
 *
 * "正常退出"由 onunload 写一个 cleanExit 标记来标记；崩溃时 onunload 根本不会执行，
 * 标记就停在旧值上，判定逻辑靠这个差异区分。
 */
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export const STATE_FILENAME = "runtime-state.json";
export const PENDING_FILENAME = "pending-crash.json";

/** 心跳间隔：20 秒。够密，也不会把磁盘写穿 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** 断点超过这么久才算非正常终止（4 个心跳周期，留出调度抖动余量） */
export const CRASH_MIN_GAP_MS = 90_000;

/**
 * 断点超过这么久就当作正常关机或长时间离线，不当崩溃提醒。
 * 否则关一晚机器第二天开机，会被误报成昨晚崩了。
 */
export const CRASH_MAX_GAP_MS = 2 * 60 * 60 * 1000;

function statePath(dir) {
  return path.join(dir, STATE_FILENAME);
}

function pendingPath(dir) {
  return path.join(dir, PENDING_FILENAME);
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

export function readState(dir) {
  return readJson(statePath(dir));
}

export function writeState(dir, state) {
  return writeJson(statePath(dir), state);
}

/**
 * 看看上一班是怎么结束的。
 * 返回 null 表示没有可疑记录；否则返回崩溃信息。
 */
export function detectPreviousCrash(dir, now = Date.now(), currentPid = process.pid) {
  const prev = readState(dir);
  if (!prev || !prev.lastHeartbeatAt) return null;

  // 同一个进程号说明只是插件被重载（禁用再启用、开发态 reload），
  // server 根本没重启，不能算崩溃。
  if (prev.pid && prev.pid === currentPid) return null;

  const lastBeat = Date.parse(prev.lastHeartbeatAt);
  if (!Number.isFinite(lastBeat)) return null;

  const cleanAt = prev.lastCleanExitAt ? Date.parse(prev.lastCleanExitAt) : 0;
  const wasClean = Number.isFinite(cleanAt) && cleanAt >= lastBeat;

  const gap = now - lastBeat;
  if (wasClean) return null;
  if (gap < CRASH_MIN_GAP_MS) return null;
  // 断得太久，更可能是正常关机或长期离线，不当崩溃
  if (gap > CRASH_MAX_GAP_MS) return null;

  return {
    detectedAt: new Date(now).toISOString(),
    lastHeartbeatAt: prev.lastHeartbeatAt,
    startedAt: prev.startedAt || null,
    previousPid: prev.pid ?? null,
    gapMs: gap,
    uptimeBeforeCrashMs: Number.isFinite(Date.parse(prev.startedAt || "")) ? lastBeat - Date.parse(prev.startedAt) : null,
  };
}

export function writePendingCrash(dir, info) {
  return writeJson(pendingPath(dir), info);
}

export function peekPendingCrash(dir) {
  return readJson(pendingPath(dir));
}

/** 取走并删除，保证只提醒一次 */
export function takePendingCrash(dir) {
  const info = readJson(pendingPath(dir));
  if (!info) return null;
  try {
    unlinkSync(pendingPath(dir));
  } catch {
    /* 删不掉也没关系，下次再试 */
  }
  return info;
}

/** 把这次崩溃记进状态文件，供 machine_state 展示 */
export function recordCrashInState(dir, info, baseState) {
  const next = { ...(baseState || readState(dir) || {}), lastCrash: info };
  return writeState(dir, next);
}
