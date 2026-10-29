/**
 * 本地自测：用假 pi 实例驱动 extension，不需要启动 Hana。
 *
 *   node test/clock-inject.test.mjs
 *
 * 会真实读几次电量（每次约 0.5 秒），结束时把配置恢复成测试前的样子。
 */
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readConfigFromFile,
  writeConfig,
  configPath,
  resolveDataDir,
  DEFAULT_TEXTS,
  DEFAULT_THRESHOLDS,
} from "../lib/settings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = pathToFileURL(path.join(HERE, "..", "extensions", "clock-inject.js")).href;

// 甩开真实插件数据：否则会读到开发态或正式版里的网络事件、崩溃待提醒，让断言飘
const fakeHome = path.join(os.tmpdir(), `hana-clock-test-${Date.now()}`);
mkdirSync(path.join(fakeHome, "plugin-data", "pc-status"), { recursive: true });
process.env.HANA_HOME = fakeHome;

const dataDir = resolveDataDir(null);
const configExisted = existsSync(configPath(dataDir));
const original = readConfigFromFile(dataDir);
const { default: factory } = await import(EXT);

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function makePi() {
  const handlers = new Map();
  return {
    handlers,
    pi: {
      on(name, fn) {
        handlers.set(name, fn);
      },
    },
  };
}

async function runOnce(pi, opts = {}) {
  const { handlers } = pi;
  await handlers.get("tool_call")({ toolName: opts.toolName || "exec_command" });
  if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  return await handlers.get("tool_result")(
    { toolName: opts.toolName || "exec_command", content: [{ type: "text", text: "hello" }] },
    opts.ctx,
  );
}

function textOf(result) {
  if (!result) return "";
  return result.content.map((c) => c.text || "").join("\n");
}

// ── 基础行为 ──
{
  const p = makePi();
  factory(p.pi);
  check("注册了 tool_call 与 tool_result", p.handlers.has("tool_call") && p.handlers.has("tool_result"));

  const first = await runOnce(p);
  check("首次返回被注入", Boolean(first) && first.content.length === 2);
  check("原始内容未被改动", first?.content?.[0]?.text === "hello");
  check("注入内容带时钟", textOf(first).includes("时钟"));

  const second = await runOnce(p);
  check("间隔内不重复注入", second === undefined);
}

// ── 慢调用提示 ──
{
  writeConfig(dataDir, { reportSlowToolSeconds: 1, clockIntervalMinutes: 480 });
  const p = makePi();
  factory(p.pi);
  const res = await runOnce(p, { delayMs: 1200 });
  check("慢调用被提示", textOf(res).includes("耗时"));
}

// ── 自定义文案 ──
{
  writeConfig(dataDir, {
    clockIntervalMinutes: 480,
    reportSlowToolSeconds: 0,
    texts: { clockLine: "CLOCK<{clock}>", clockVitalsSuffix: "" },
  });
  const p = makePi();
  factory(p.pi);
  const res = await runOnce(p);
  check("自定义 clockLine 生效", textOf(res).includes("CLOCK<"), textOf(res));
  check("自定义模板未吞掉时间", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(textOf(res)));
}

// ── 鼓励语：阈值放宽到 100，必然落在偏低区间 ──
{
  writeConfig(dataDir, {
    clockIntervalMinutes: 480,
    includeVitalsInClock: true,
    thresholds: { batteryLow: 100, batteryCritical: 99 },
    texts: { encouragement: "ENC-测试鼓励" },
    encouragement: { mode: "auto", matchModels: ["deepseek"], text: "" },
  });
  const p = makePi();
  factory(p.pi);
  const res = await runOnce(p, { ctx: { model: { provider: "deepseek", id: "deepseek-flash" } } });
  check("DeepSeek 命中时追加鼓励", textOf(res).includes("ENC-测试鼓励"), textOf(res));

  const p2 = makePi();
  factory(p2.pi);
  const res2 = await runOnce(p2, { ctx: { model: { provider: "anthropic", id: "claude" } } });
  check("非匹配模型不追加鼓励", !textOf(res2).includes("ENC-测试鼓励"), textOf(res2));

  const p3 = makePi();
  factory(p3.pi);
  const res3 = await runOnce(p3, { ctx: null });
  check("拿不到模型信息时不崩且不追加", !textOf(res3).includes("ENC-测试鼓励"));
}

// ── 鼓励语关闭 ──
{
  writeConfig(dataDir, {
    clockIntervalMinutes: 480,
    thresholds: { batteryLow: 100 },
    encouragement: { mode: "off", matchModels: ["deepseek"], text: "" },
  });
  const p = makePi();
  factory(p.pi);
  const res = await runOnce(p, { ctx: { model: { provider: "deepseek", id: "deepseek-flash" } } });
  check("mode=off 时不追加", !textOf(res).includes("资源紧张"), textOf(res));
}

// ── 畸形输入不崩 ──
{
  const p = makePi();
  factory(p.pi);
  check("null 事件安全返回", (await p.handlers.get("tool_result")(null)) === undefined);
  check("缺少 content 时安全返回", (await p.handlers.get("tool_result")({ toolName: "x" })) === undefined);
}

// ── 关闭开关 ──
{
  writeConfig(dataDir, { clockInjectEnabled: false, reportSlowToolSeconds: 0 });
  const p = makePi();
  factory(p.pi);
  check("关闭后不注入", (await runOnce(p)) === undefined);
}

// ── 恢复 ──
if (configExisted) {
  writeConfig(dataDir, {
    ...original,
    thresholds: { ...DEFAULT_THRESHOLDS },
    texts: { ...DEFAULT_TEXTS },
  });
}
rmSync(fakeHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
