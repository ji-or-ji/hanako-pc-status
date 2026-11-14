/**
 * 钩子与工具自测：用假 sdk 驱动，不需要启动 Hana。
 *
 *   node test/hooks.test.mjs
 *
 * 会真实调一次 PowerShell 读本机状态（约 1-2 秒）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../lib/runtime.js";
import { createSnapshotter } from "../lib/snapshot.js";
import { registerHooks } from "../lib/hooks.js";
import { register as registerMachineState } from "../tools/machine-state.js";
import { writePendingOutage } from "../lib/network-watch.js";

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), "pc-status-hooks-"));

const adjudicators = new Map();
const tools = new Map();
const flatConfig = {
  clockInjectEnabled: true,
  clockIntervalMinutes: 10,
  includeVitalsInClock: true,
  reportSlowToolSeconds: 0,
  networkWatchEnabled: true,
  networkProbeIntervalSeconds: 25,
  networkOutageThresholdMinutes: 5,
  batteryLowPercent: 30,
  batteryCriticalPercent: 10,
  memoryHighPercent: 92,
  diskLowGB: 5,
  serverMemoryHighMB: 2048,
  encouragementMode: "auto",
  encouragementModels: "deepseek",
  encouragementText: "",
  stateInjectEnabled: true,
  stateInjectRefreshSeconds: 30,
  stateInjectIncludeLoad: false,
  stateInjectIncludeWarning: true,
  stateInjectTemplate: "[pc-status] {clock} {weekday} · {power} · {network}",
};

const sdk = {
  dataDir,
  logger: { info: async () => {}, warn: async () => {}, debug: async () => {}, error: async () => {} },
  config: {
    getAll: async () => flatConfig,
    setMany: async () => {},
  },
  network: { fetch: async () => ({ status: 200 }) },
  bus: { request: async () => { throw new Error("no session"); } },
  hooks: {
    onDecision: (word, fn) => {
      adjudicators.set(word, fn);
      return () => {};
    },
  },
  tools: { register: async (tool) => tools.set(tool.name, tool) },
};

const runtime = createRuntime(sdk);
const snapshotter = createSnapshotter(sdk, runtime);
runtime.state.ensureSnapshot = () => snapshotter.refresh(true);
registerHooks(sdk, runtime);
await registerMachineState(sdk, runtime);

check("三个钩子都注册上了", ["tools/pre-execute", "tools/post-execute", "agent/before-start"].every((w) => adjudicators.has(w)));
check("工具注册上了", tools.has("machine_state"));

// ── post-execute：时钟行 ────────────────────────────────────────────
runtime.state.lastInjectedAt = 0;
runtime.state.lastToolStartedAt = Date.now();
const result = await adjudicators.get("tools/post-execute")({
  toolName: "demo",
  content: [{ type: "text", text: "原始输出" }],
  session: { sessionId: "s1", sessionPath: null },
});
const appended = result?.content?.[1]?.text || "";
check("原始内容保留", result?.content?.[0]?.text === "原始输出");
check("追加了时钟行", appended.includes("[pc-status] 时钟"), appended);
check("时钟行带电量", appended.includes("%"), appended);

// 节流：同一次间隔内再调一次不应该再追加
const again = await adjudicators.get("tools/post-execute")({
  toolName: "demo",
  content: [{ type: "text", text: "原始输出" }],
  session: { sessionId: "s1", sessionPath: null },
});
check("间隔内不重复注入", again === undefined, JSON.stringify(again));

// ── before-start：每轮都带一条状态 ─────────────────────────────────
const turn = await adjudicators.get("agent/before-start")({ prompt: "hi", systemPrompt: "", session: { sessionId: "s1" } });
const turnText = turn?.message?.content || "";
check("每轮都注入状态", turn?.message?.customType === "pc-status-turn-state", JSON.stringify(turn));
check("状态行带时间", /\[pc-status\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(turnText), turnText);
check("状态行带电量（快照已补采）", /电量|交流电|电池/.test(turnText), turnText);
check("状态不可见", turn?.message?.display === false);

// ── before-start：有待提醒时递一张不可见便条，且与状态合并在一条消息里 ──────────────
writePendingOutage(dataDir, { startedAt: new Date(Date.now() - 600000).toISOString(), endedAt: new Date().toISOString(), outageMs: 600000 });
const notice = await adjudicators.get("agent/before-start")({ prompt: "hi", systemPrompt: "", session: { sessionId: "s1" } });
const noticeText = notice?.message?.content || "";
check("断网便条与状态同在一张", noticeText.includes("<pc-status-network-notice>") && noticeText.includes("[pc-status]"), noticeText.slice(0, 160));
check("断网便条不可见", notice?.message?.display === false);
const noticeAgain = await adjudicators.get("agent/before-start")({ prompt: "hi", systemPrompt: "", session: { sessionId: "s1" } });
check("便条只递一次", !(noticeAgain?.message?.content || "").includes("<pc-status-network-notice>"));
const stillState = await adjudicators.get("agent/before-start")({ prompt: "hi", systemPrompt: "", session: { sessionId: "s1" } });
check("但每轮状态照旧", (stillState?.message?.content || "").includes("[pc-status]"), JSON.stringify(stillState));

// ── 关掉状态注入后，这一轮就不说话 ──────────────────────────────
flatConfig.stateInjectEnabled = false;
runtime.invalidateConfig();
const muted = await adjudicators.get("agent/before-start")({ prompt: "hi", systemPrompt: "", session: { sessionId: "s1" } });
check("关掉后不注入状态", muted === undefined, JSON.stringify(muted));
flatConfig.stateInjectEnabled = true;
runtime.invalidateConfig();

// ── machine_state ───────────────────────────────────────────────────
const state = await tools.get("machine_state").execute({ format: "text" });
const stateText = state?.content?.[0]?.text || "";
check("machine_state 有内容", stateText.length > 20, stateText.slice(0, 120));
check("machine_state 提到电源", stateText.includes("电源") || stateText.includes("失败"), stateText.slice(0, 120));

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
