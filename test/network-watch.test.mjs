/**
 * 网络监测自测：不需要真的拔网线，直接喂探测结果。
 *
 *   node test/network-watch.test.mjs
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const fakeHome = path.join(os.tmpdir(), `hana-net-test-${Date.now()}`);
const dataDir = path.join(fakeHome, "plugin-data", "pc-status");
mkdirSync(dataDir, { recursive: true });
process.env.HANA_HOME = fakeHome;

const net = await import(pathToFileURL(path.join("D:", "hanako-workspace", "pc-status", "lib", "network-watch.js")).href);
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

const probeOnline = { status: "online", dnsOk: true, latencyMs: 15, checkedAt: new Date().toISOString(), target: "223.5.5.5:53", detail: "ok" };
const probeOffline = { status: "offline", dnsOk: false, latencyMs: 2500, checkedAt: new Date().toISOString(), target: "223.5.5.5:53", detail: "tcp-failed" };
const probeDnsDown = { status: "online", dnsOk: false, latencyMs: 15, checkedAt: new Date().toISOString(), target: "223.5.5.5:53", detail: "dns-ENOTFOUND" };

// ── 状态机：首次建立基线，不产生事件 ──
let r = net.applyProbe(null, probeOnline);
check("首次探测建立基线", r.changed === false && r.state.status === "online", JSON.stringify(r.event));

// ── 单次抖动不触发（需要连续 2 次）──
r = net.applyProbe(r.state, probeOffline);
check("第一次离线只是 candidate", r.changed === false && r.state.candidate?.count === 1, JSON.stringify(r.state.candidate));
r = net.applyProbe(r.state, probeOffline);
check("连续两次离线才确认", r.changed === true && r.state.status === "offline", JSON.stringify(r.state));
check("离线事件记录了方向", r.event.from.status === "online" && r.event.to.status === "offline", JSON.stringify(r.event));

// ── 恢复：计算中断时长 ──
const offlineAt = Date.parse(r.state.changedAt);
r = net.applyProbe(r.state, probeOnline, offlineAt + 90_000);
check("第一次恢复是 candidate", r.changed === false);
r = net.applyProbe(r.state, probeOnline, offlineAt + 91_000);
check("连续两次恢复才确认", r.changed === true && r.state.status === "online", JSON.stringify(r.state));
check("恢复了中断时长", r.event.outageMs >= 90_000 && r.event.outageMs <= 92_000, r.event.outageMs);

// ── DNS 状态翻转也算变动 ──
r = net.applyProbe(r.state, probeDnsDown);
r = net.applyProbe(r.state, probeDnsDown);
check("DNS 失效被识别", r.changed === true && r.state.dnsOk === false, JSON.stringify(r.event));

// ── 事件队列：写入、取走、清空 ──
net.appendPendingEvent(dataDir, { at: "2026-10-27T13:00:00.000Z", from: { status: "online" }, to: { status: "offline" } });
net.appendPendingEvent(dataDir, { at: "2026-10-27T13:01:00.000Z", from: { status: "offline" }, to: { status: "online" }, outageMs: 60000 });
check("事件可写入", net.readPendingEvents(dataDir).length === 2);
const taken = net.takePendingEvents(dataDir);
check("取走后拿到全部", taken.length === 2 && taken[1].outageMs === 60000);
check("取走后文件清空", net.readPendingEvents(dataDir).length === 0);

// ── 队列上限 ──
for (let i = 0; i < 9; i++) net.appendPendingEvent(dataDir, { at: String(i), from: {}, to: {} });
check("队列不超过上限", net.readPendingEvents(dataDir).length === net.MAX_PENDING_EVENTS, String(net.readPendingEvents(dataDir).length));
net.takePendingEvents(dataDir);

// ── 断网记录：写入 / 读取 / 消费 ──
net.writePendingOutage(dataDir, { startedAt: "2026-10-27T13:00:00.000Z", endedAt: "2026-10-27T13:12:00.000Z", outageMs: 720000 });
check("断网记录可读", net.peekPendingOutage(dataDir)?.outageMs === 720000);
const outage = net.takePendingOutage(dataDir);
check("取走断网记录", outage?.outageMs === 720000);
check("取走后消失", net.peekPendingOutage(dataDir) === null);

// ── extension：工具返回时把变动注入成一行 ──
net.appendPendingEvent(dataDir, { at: new Date().toISOString(), from: { status: "online", dnsOk: true }, to: { status: "offline", dnsOk: false }, outageMs: null });

const handlers = new Map();
const pi = { on: (n, f) => handlers.set(n, f), sendMessage: () => {} };
const ext = await import(EXT);
ext.default(pi);

await handlers.get("tool_call")({});
const res = await handlers.get("tool_result")({ toolName: "exec_command", content: [{ type: "text", text: "x" }] }, {});
const text = (res?.content || []).map((c) => c.text || "").join("");
check("工具返回里注入了网络变动", text.includes("网络中断"), text);
check("事件被消费掉", net.readPendingEvents(dataDir).length === 0);

// ── extension：断网便条 ──
net.writePendingOutage(dataDir, { startedAt: "2026-10-27T13:00:00.000Z", endedAt: "2026-10-27T13:12:00.000Z", outageMs: 720000 });
const sent = [];
const handlers2 = new Map();
const pi2 = { on: (n, f) => handlers2.set(n, f), sendMessage: (payload, opts) => sent.push({ payload, opts }) };
const ext2 = await import(`${EXT}?v=${Date.now()}`);
ext2.default(pi2);
handlers2.get("session_start")({}, {});
await new Promise((r2) => setTimeout(r2, 700));

const notice = sent.find((s) => s.payload?.customType === "pc-status-network-notice");
check("会话开头递出断网便条", Boolean(notice), JSON.stringify(sent.map((s) => s.payload?.customType)));
check("便条对用户不可见", notice?.payload?.display === false);
check("便条说明了时长", (notice?.payload?.content || "").includes("12分"), (notice?.payload?.content || "").slice(0, 120));
check("便条取走后不重复", net.peekPendingOutage(dataDir) === null);

rmSync(fakeHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
