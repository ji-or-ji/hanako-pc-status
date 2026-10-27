/**
 * 崩溃监测自测：不需要真的把 server 弄崩，直接造一个"断掉的心跳"文件。
 *
 *   node test/crash-watch.test.mjs
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const fakeHome = path.join(os.tmpdir(), `hana-crash-test-${Date.now()}`);
const dataDir = path.join(fakeHome, "plugin-data", "pc-status");
mkdirSync(dataDir, { recursive: true });
process.env.HANA_HOME = fakeHome;

const watch = await import(pathToFileURL(path.join("D:", "hanako-workspace", "pc-status", "lib", "runtime-watch.js")).href);
const EXT = pathToFileURL(path.join("D:", "hanako-workspace", "pc-status", "extensions", "clock-inject.js")).href;

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function writeState(state) {
  writeFileSync(path.join(dataDir, "runtime-state.json"), JSON.stringify(state, null, 2), "utf8");
}

// ── 场景 1：心跳停在 3 分钟前，没有干净退出 → 判定崩溃 ──
writeState({
  pid: 1234,
  startedAt: iso(now - 3600_000),
  lastHeartbeatAt: iso(now - 180_000),
  lastCleanExitAt: iso(now - 7200_000),
});
let crash = watch.detectPreviousCrash(dataDir, now, 4321);
check("心跳中断 3 分钟判为崩溃", Boolean(crash), JSON.stringify(crash));
check("崩溃记录带中断时长", crash && crash.gapMs >= 179_000 && crash.gapMs <= 181_000, crash?.gapMs);
check("崩溃记录带崩溃前运行时长", crash && crash.uptimeBeforeCrashMs > 3_000_000, crash?.uptimeBeforeCrashMs);

// ── 场景 2：干净退出 → 不算崩溃 ──
writeState({
  startedAt: iso(now - 3600_000),
  lastHeartbeatAt: iso(now - 600_000),
  lastCleanExitAt: iso(now - 590_000),
});
check("有干净退出标记时不算崩溃", watch.detectPreviousCrash(dataDir, now, 4321) === null);

// ── 场景 3：断点太短，可能只是刚重启 → 不算 ──
writeState({
  startedAt: iso(now - 3600_000),
  lastHeartbeatAt: iso(now - 20_000),
  lastCleanExitAt: null,
});
check("断点 20 秒不误报", watch.detectPreviousCrash(dataDir, now, 4321) === null);

// ── 场景 4：断点太久（关机过夜）→ 不算崩溃 ──
writeState({
  startedAt: iso(now - 20 * 3600_000),
  lastHeartbeatAt: iso(now - 5 * 3600_000),
  lastCleanExitAt: null,
});
check("断点 5 小时视为正常关机", watch.detectPreviousCrash(dataDir, now, 4321) === null);

// ── 场景 5：没有历史文件 → 不算 ──
rmSync(path.join(dataDir, "runtime-state.json"), { force: true });
check("首次运行不误报", watch.detectPreviousCrash(dataDir, now, 4321) === null);

// ── 场景 5b：同一个 pid 说明只是插件重载，不算崩溃 ──
writeState({
  pid: 4321,
  startedAt: iso(now - 3600_000),
  lastHeartbeatAt: iso(now - 600_000),
  lastCleanExitAt: null,
});
check("同进程内重载插件不误报", watch.detectPreviousCrash(dataDir, now, 4321) === null);

// ── 场景 6：待提醒记录的写入 / 读取 / 消费 ──
const info = {
  detectedAt: iso(now),
  lastHeartbeatAt: iso(now - 180_000),
  startedAt: iso(now - 3600_000),
  gapMs: 180_000,
  uptimeBeforeCrashMs: 3_420_000,
};
watch.writePendingCrash(dataDir, info);
check("待提醒记录可读", watch.peekPendingCrash(dataDir)?.gapMs === 180_000);
const taken = watch.takePendingCrash(dataDir);
check("取走后能拿到内容", taken?.gapMs === 180_000);
check("取走后文件消失", watch.peekPendingCrash(dataDir) === null);

// ── 场景 7：extension 在会话启动时递便条，且只递一次 ──
watch.writePendingCrash(dataDir, info);

const sent = [];
const handlers = new Map();
const pi = {
  on(name, fn) {
    handlers.set(name, fn);
  },
  sendMessage(payload, options) {
    sent.push({ payload, options });
  },
};

const ext = await import(EXT);
ext.default(pi);
check("注册了 session_start", handlers.has("session_start"));

handlers.get("session_start")({}, {});
await new Promise((r) => setTimeout(r, 700));

check("会话启动时递出便条", sent.length === 1, `sent=${sent.length}`);
const body = sent[0]?.payload?.content || "";
check("便条对用户不可见", sent[0]?.payload?.display === false);
check("便条不主动触发新 turn", sent[0]?.options?.triggerTurn === false);
check("便条说明了中断时长", body.includes("3分") || body.includes("3 分"), body.slice(0, 200));
check("便条提示上下文可能缺失", body.includes("上下文") || body.includes("可能"), body.slice(0, 200));
check("递完即消费，不会重复提醒", watch.peekPendingCrash(dataDir) === null);

// 再触发一次 session_start，不应再递
handlers.get("session_start")({}, {});
await new Promise((r) => setTimeout(r, 700));
check("第二次会话启动不再提醒", sent.length === 1, `sent=${sent.length}`);

// ── 场景 8：关掉提醒后不再递，并且不积压 ──
writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ schemaVersion: 1, global: { crashNoticeEnabled: false }, agents: {}, sessions: {} }, null, 2),
  "utf8",
);
watch.writePendingCrash(dataDir, info);
const sent2 = [];
const h2 = new Map();
const pi2 = { on: (n, f) => h2.set(n, f), sendMessage: (p, o) => sent2.push({ p, o }) };
const ext2 = await import(`${EXT}?v=${Date.now()}`);
ext2.default(pi2);
h2.get("session_start")({}, {});
await new Promise((r) => setTimeout(r, 700));
check("关闭提醒后不递便条", sent2.length === 0, `sent=${sent2.length}`);
check("关闭提醒后不积压待提醒", watch.peekPendingCrash(dataDir) === null);

rmSync(fakeHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
