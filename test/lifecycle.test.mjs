/**
 * 生命周期自测：用假 ctx 驱动 index.js，验证心跳写入、崩溃判定与干净退出标记。
 *
 *   node test/lifecycle.test.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const fakeHome = path.join(os.tmpdir(), `hana-lifecycle-test-${Date.now()}`);
const dataDir = path.join(fakeHome, "plugin-data", "pc-status");
mkdirSync(dataDir, { recursive: true });
process.env.HANA_HOME = fakeHome;

const PLUGIN = pathToFileURL(path.join("D:", "hanako-workspace", "pc-status", "index.js")).href;

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

function readState() {
  const file = path.join(dataDir, "runtime-state.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function pendingExists() {
  return existsSync(path.join(dataDir, "pending-crash.json"));
}

// 直接用 dynamic import 拿 class
const { default: PcStatusPlugin } = await import(PLUGIN);

function newInstance() {
  const plugin = new PcStatusPlugin();
  plugin.ctx = {
    dataDir,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  plugin.register = () => {};
  return plugin;
}

// ── 场景 1：首次运行，没有历史 ──
{
  const plugin = newInstance();
  await plugin.onload();
  // Hana 安装插件时会序列化实例，实例上不能挂定时器之类的活动对象
  let serializable = true;
  try {
    JSON.stringify(plugin);
  } catch {
    serializable = false;
  }
  check("插件实例可被序列化", serializable, `字段: ${Object.keys(plugin).join(",")}`);

  const state = readState();
  check("首次运行写入了心跳", Boolean(state?.lastHeartbeatAt), JSON.stringify(state));
  check("首次运行记下 pid", state?.pid === process.pid);
  check("首次运行不产生崩溃待提醒", pendingExists() === false);
  plugin.onunload();
  check("卸载时写入干净退出标记", Boolean(readState()?.lastCleanExitAt));
}

// ── 场景 2：模拟上一班崩溃（心跳停在 3 分钟前，无干净退出）──
{
  const now = Date.now();
  writeFileSync(
    path.join(dataDir, "runtime-state.json"),
    JSON.stringify(
      {
        pid: 999,
        startedAt: new Date(now - 3600_000).toISOString(),
        lastHeartbeatAt: new Date(now - 180_000).toISOString(),
        lastCleanExitAt: new Date(now - 7200_000).toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  const plugin = newInstance();
  await plugin.onload();
  check("崩溃后产生了待提醒", pendingExists() === true);

  const pending = JSON.parse(readFileSync(path.join(dataDir, "pending-crash.json"), "utf8"));
  check("待提醒里带中断时长", pending.gapMs >= 179_000 && pending.gapMs <= 181_000, pending.gapMs);

  const state = readState();
  check("崩溃记录写进状态文件", Boolean(state?.lastCrash), JSON.stringify(state?.lastCrash));
  check("重新启动后心跳已刷新", Date.parse(state.lastHeartbeatAt) > now - 5_000);

  plugin.onunload();
  check("卸载后干净退出时间晚于最后心跳", Date.parse(readState().lastCleanExitAt) >= Date.parse(readState().lastHeartbeatAt));
  check("卸载后不再产生新的崩溃待提醒", pendingExists() === true, "这是上一次留下的，应保持不变");
}

// ── 场景 3：干净退出后重启，不该再报崩溃 ──
{
  rmSync(path.join(dataDir, "pending-crash.json"), { force: true });
  const plugin = newInstance();
  await plugin.onload();
  check("干净退出后重启不产生崩溃提醒", pendingExists() === false);

  // 心跳定时器要清掉，别让测试进程挂着
  plugin.onunload();
}

// ── 场景 4：异常上下文的容错 ──
{
  const plugin = new PcStatusPlugin();
  plugin.ctx = { dataDir: path.join(fakeHome, "nope"), log: undefined };
  plugin.register = () => {};
  let threw = false;
  try {
    await plugin.onload();
    plugin.onunload();
  } catch {
    threw = true;
  }
  check("目录不存在时不抛异常", threw === false);
}

rmSync(fakeHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
