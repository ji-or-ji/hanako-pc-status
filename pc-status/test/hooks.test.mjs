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

// ── before-start：没有待提醒时安静 ──────────────────────────────────
const quiet = await adjudicators.get("agent/before-start")({ prompt: "hi", systemPrompt: "", session: { sessionId: "s1" } });
check("没有断网记录时不插话", quiet === undefined, JSON.stringify(quiet));

// ── before-start：有待提醒时递一张不可见便条 ────────────────────────
writePendingOutage(dataDir, { startedAt: new Date(Date.now() - 600000).toISOString(), endedAt: new Date().toISOString(), outageMs: 600000 });
const notice = await adjudicators.get("agent/before-start")({ prompt: "hi", systemPrompt: "", session: { sessionId: "s1" } });
check("断网便条有 customType", notice?.message?.customType === "pc-status-network-notice", JSON.stringify(notice));
check("断网便条不可见", notice?.message?.display === false);
const noticeAgain = await adjudicators.get("agent/before-start")({ prompt: "hi", systemPrompt: "", session: { sessionId: "s1" } });
check("便条只递一次", noticeAgain === undefined);

// ── machine_state ───────────────────────────────────────────────────
const state = await tools.get("machine_state").execute({ format: "text" });
const stateText = state?.content?.[0]?.text || "";
check("machine_state 有内容", stateText.length > 20, stateText.slice(0, 120));
check("machine_state 提到电源", stateText.includes("电源") || stateText.includes("失败"), stateText.slice(0, 120));

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
