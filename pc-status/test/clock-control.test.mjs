/**
 * clock_control 自测：查看与修改配置都不碰真配置，用假 sdk 记下写入内容。
 *
 *   node test/clock-control.test.mjs
 */
import { register } from "../tools/clock-control.js";

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

let flat = {
  clockInjectEnabled: true,
  clockIntervalMinutes: 10,
  includeVitalsInClock: true,
  reportSlowToolSeconds: 60,
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
let written = null;
let invalidated = 0;
const tools = new Map();

const sdk = {
  logger: { info: async () => {}, warn: async () => {} },
  config: {
    getAll: async () => ({ ...flat }),
    setMany: async (patch) => {
      written = patch;
      flat = { ...flat, ...patch };
    },
  },
  tools: { register: async (tool) => tools.set(tool.name, tool) },
};
const runtime = { invalidateConfig: () => { invalidated += 1; } };

await register(sdk, runtime);
const tool = tools.get("clock_control");
check("工具注册上了", Boolean(tool));

const view = await tool.execute({});
check("无参数时回报当前设置", typeof view === "string" && view.includes("配置来源"), String(view).slice(0, 80));
check("回报里带时钟行文案", view.includes("textClockLine") || view.includes("[pc-status] 时钟"));
check("没有崩溃后提醒这一项了", !view.includes("崩溃后提醒"));

const after = await tool.execute({ intervalMinutes: 30, texts: { clockLine: "[pc] {clock}" }, encouragementModels: ["deepseek", "qwen"] });
check("写入返回 render 文本", String(after).includes("已更新"));
check("写入了间隔", written?.clockIntervalMinutes === 30, JSON.stringify(written?.clockIntervalMinutes));
check("写入了文案", written?.textClockLine === "[pc] {clock}");
check("写入了模型列表", written?.encouragementModels === "deepseek,qwen");
check("写入后让缓存失效", invalidated === 1);

const afterReset = await tool.execute({ resetThresholds: true });
check("恢复阈值可用", String(afterReset).includes("已更新") && written?.batteryLowPercent === 30);

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
