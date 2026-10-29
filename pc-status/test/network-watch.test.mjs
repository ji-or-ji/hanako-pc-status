/**
 * 网络监测自测：不需要真的拔网线。
 *
 *   node test/network-watch.test.mjs
 *
 * 覆盖三件事：
 * - probeNetwork 把「拿到 HTTP 状态」判为在线、抛错判为离线（v2 只走 fetch）
 * - applyProbe 的去抖与事件生成
 * - 待提示事件的存取
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeNetwork,
  applyProbe,
  appendPendingEvent,
  takePendingEvents,
  writePendingOutage,
  takePendingOutage,
  readNetworkState,
  writeNetworkState,
} from "../lib/network-watch.js";

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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "pc-status-net-"));

// ── probeNetwork ────────────────────────────────────────────────────
const online = await probeNetwork(async () => ({ status: 200 }));
check("HTTP 200 → 在线", online.status === "online" && online.dnsOk === true, JSON.stringify(online));

const notFound = await probeNetwork(async () => ({ status: 404 }));
check("HTTP 404 也算在线（链路通）", notFound.status === "online");

const offline = await probeNetwork(async () => {
  throw new Error("getaddrinfo ENOTFOUND www.baidu.com");
});
check("fetch 抛错 → 离线", offline.status === "offline" && offline.dnsOk === false, JSON.stringify(offline));

const noFetch = await probeNetwork(undefined);
check("没有 fetch 实现 → 离线且不崩", noFetch.status === "offline");

// ── applyProbe 去抖 ─────────────────────────────────────────────────
const probeOk = { status: "online", dnsOk: true, latencyMs: 20, checkedAt: new Date().toISOString(), target: "x" };
const probeDown = { status: "offline", dnsOk: false, latencyMs: 0, checkedAt: new Date().toISOString(), target: "x" };

const first = applyProbe(null, probeOk, 1000);
check("首次探测只建基线，不产生事件", first.changed === false && first.event === null);

const down1 = applyProbe(first.state, probeDown, 2000);
check("第一次变化只记候选", down1.changed === false && down1.state.candidate?.count === 1);

const down2 = applyProbe(down1.state, probeDown, 3000);
check("连续两次一致才确认切换", down2.changed === true && down2.event?.to.status === "offline");

const back1 = applyProbe(down2.state, probeOk, 9000);
const back2 = applyProbe(back1.state, probeOk, 10000);
check("恢复也被确认，并带上断网时长", back2.changed === true && back2.event?.outageMs === 7000, JSON.stringify(back2.event));

// ── 待提示事件与断网记录 ────────────────────────────────────────────
appendPendingEvent(dataDir, down2.event);
appendPendingEvent(dataDir, back2.event);
check("事件累积", takePendingEvents(dataDir).length === 2);
check("取走即清空", takePendingEvents(dataDir).length === 0);

writePendingOutage(dataDir, { outageMs: 600000 });
check("断网记录只取一次", takePendingOutage(dataDir)?.outageMs === 600000 && takePendingOutage(dataDir) === null);

writeNetworkState(dataDir, { status: "online" });
check("网络状态可回读", readNetworkState(dataDir)?.status === "online");

rmSync(dataDir, { recursive: true, force: true });

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
