/**
 * 系统状态采集与渲染。
 *
 * 两个入口：
 * - collectMachineState()  完整状态，给 machine_state 工具用
 * - readVitals()           轻量状态（约 0.5 秒），给时钟注入用
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPowerShellScript } from "./powershell.js";
import { fillTemplate } from "./text.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FULL_SCRIPT = path.join(HERE, "collect-system.ps1");
const VITALS_SCRIPT = path.join(HERE, "collect-vitals.ps1");

export async function collectMachineState(options = {}) {
  const flags = [];
  if (options.includeBatteryHealth) flags.push("battery-health");
  if (options.allPowerSchemes) flags.push("all-schemes");
  return await runPowerShellScript(FULL_SCRIPT, { flags, timeoutMs: 20000 });
}

export async function readVitals() {
  return await runPowerShellScript(VITALS_SCRIPT, { flags: [], timeoutMs: 4000 });
}

// ── 渲染 ────────────────────────────────────────────────────────────

const WEEKDAY_ZH = {
  Sunday: "周日",
  Monday: "周一",
  Tuesday: "周二",
  Wednesday: "周三",
  Thursday: "周四",
  Friday: "周五",
  Saturday: "周六",
};

const AC_LINE_ZH = {
  online: "交流电供电",
  offline: "电池供电",
  unknown: "供电状态未知",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 用本地时钟生成时间戳（不依赖 PowerShell 返回的字符串精度） */
export function formatStamp(date = new Date(), offsetHint) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = offsetHint || `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  const weekday = WEEKDAY_ZH[["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()]] || "";
  return {
    clock: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
    offset,
    weekday,
    full: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${offset} ${weekday}`,
  };
}

export function humanDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "未知";
  let s = Math.max(0, Math.round(Number(seconds)));
  const day = Math.floor(s / 86400);
  s -= day * 86400;
  const hour = Math.floor(s / 3600);
  s -= hour * 3600;
  const minute = Math.floor(s / 60);
  const second = s - minute * 60;

  const parts = [];
  if (day > 0) parts.push(`${day}天`);
  if (hour > 0) parts.push(`${hour}小时`);
  if (minute > 0 && day === 0) parts.push(`${minute}分`);
  if (second > 0 && day === 0 && hour === 0) parts.push(`${second}秒`);
  if (parts.length === 0) return "不到 1 秒";
  return parts.join("");
}

export function humanMinutes(minutes) {
  if (minutes === null || minutes === undefined) return "未知";
  const m = Math.max(0, Math.round(Number(minutes)));
  const hour = Math.floor(m / 60);
  const minute = m % 60;
  if (hour === 0) return `${minute} 分钟`;
  if (minute === 0) return `${hour} 小时`;
  return `${hour} 小时 ${minute} 分`;
}

/** 按配置的阈值判定电量等级，百分比缺失时退回系统给的标志位 */
export function batteryLevel(battery, config) {
  const thresholds = config?.thresholds || {};
  const critical = Number(thresholds.batteryCritical);
  const low = Number(thresholds.batteryLow);
  const criticalLine = Number.isFinite(critical) ? critical : 10;
  const lowLine = Number.isFinite(low) ? low : 30;

  const percent = battery?.percent ?? battery?.batteryPercent;
  if (typeof percent === "number") {
    if (percent <= criticalLine) return "critical";
    if (percent <= lowLine) return "low";
    return "ok";
  }
  if (battery?.critical) return "critical";
  if (battery?.low) return "low";
  return "ok";
}

/** 一句话描述电量与供电，给注入和文本渲染共用 */
export function describePower(data, config) {
  const battery = data?.battery;
  const acLine = data?.acLine || "unknown";
  if (!battery || battery.present === false) {
    return `无电池 · ${AC_LINE_ZH[acLine] || "供电状态未知"}`;
  }
  const level = batteryLevel(battery, config);
  const bits = [`电池 ${battery.percent === null || battery.percent === undefined ? "?" : battery.percent}%`];
  const state = [];
  if (level === "critical") state.push("危急");
  else if (level === "low") state.push("偏低");
  if (battery.charging) state.push("充电中");
  else if (acLine === "offline") state.push("放电中");
  if (state.length) bits[0] += `（${state.join("，")}）`;
  if (battery.minutesLeft !== null && battery.minutesLeft !== undefined) {
    bits.push(`剩余约 ${humanMinutes(battery.minutesLeft)}`);
  }
  return `${AC_LINE_ZH[acLine] || "供电状态未知"} · ${bits.join(" · ")}`;
}

/** 短摘要，用在时钟注入里 */
export function vitalsSummary(vitals, config) {
  if (!vitals) return null;
  if (vitals.batteryPresent === false) return "无电池";
  const level = batteryLevel(vitals, config);
  const bits = [];
  if (vitals.batteryPercent !== null && vitals.batteryPercent !== undefined) {
    const state = [];
    if (level === "critical") state.push("危急");
    else if (level === "low") state.push("偏低");
    if (vitals.charging) state.push("充电中");
    else if (vitals.acLine === "offline") state.push("放电中");
    bits.push(`电量 ${vitals.batteryPercent}%${state.length ? `（${state.join("，")}）` : ""}`);
  }
  if (vitals.minutesLeft !== null && vitals.minutesLeft !== undefined) bits.push(`剩约 ${humanMinutes(vitals.minutesLeft)}`);
  if (bits.length === 0) return vitals.acLine === "online" ? "交流电供电" : "电池供电";
  return bits.join(" · ");
}

/** 风险提示：只报真正需要人/agent 注意的，文案与阈值都可配 */
export function collectWarnings(data, config) {
  const thresholds = config?.thresholds || {};
  const texts = config?.texts || {};
  const warnings = [];

  const battery = data?.battery;
  if (battery && battery.present !== false) {
    const level = batteryLevel(battery, config);
    if (level === "critical") {
      warnings.push(fillTemplate(texts.batteryCritical, { percent: battery.percent }));
    } else if (level === "low") {
      warnings.push(
        battery.charging
          ? fillTemplate(texts.batteryLowCharging, { percent: battery.percent })
          : fillTemplate(texts.batteryLowDischarging, { percent: battery.percent }),
      );
    }
  }

  const mem = data?.system?.memoryUsedPercent;
  const memLine = Number(thresholds.memoryHigh);
  if (typeof mem === "number" && Number.isFinite(memLine) && mem >= memLine) {
    warnings.push(fillTemplate(texts.memoryHigh, { usedPercent: mem }));
  }

  const diskLine = Number(thresholds.diskLowGB);
  const disks = Array.isArray(data?.system?.disks) ? data.system.disks : [];
  for (const disk of disks) {
    if (typeof disk.freeGB === "number" && Number.isFinite(diskLine) && disk.freeGB < diskLine) {
      warnings.push(fillTemplate(texts.diskLow, { disk: disk.name, freeGB: disk.freeGB }));
    }
  }

  const hana = Array.isArray(data?.hana) ? data.hana : [];
  const server = hana.find((p) => p.name === "hana-server");
  if (server && server.running === false) {
    warnings.push(fillTemplate(texts.serverMissing, {}));
  }
  const serverMemLine = Number(thresholds.serverMemoryHighMB);
  if (server && typeof server.memoryMB === "number" && Number.isFinite(serverMemLine) && server.memoryMB > serverMemLine) {
    warnings.push(fillTemplate(texts.serverHeavy, { memoryMB: server.memoryMB }));
  }

  return warnings;
}

/** 把一次崩溃记录说成人话 */
export function describeCrash(crash) {
  if (!crash) return "无记录";
  const bits = [];
  const beat = crash.lastHeartbeatAt ? new Date(crash.lastHeartbeatAt) : null;
  if (beat && !Number.isNaN(beat.getTime())) {
    const s = formatStamp(beat);
    bits.push(`最后心跳 ${s.clock}`);
  }
  if (typeof crash.gapMs === "number") bits.push(`中断 ${humanDuration(Math.round(crash.gapMs / 1000))}`);
  if (typeof crash.uptimeBeforeCrashMs === "number" && crash.uptimeBeforeCrashMs > 0) {
    bits.push(`崩溃前已运行 ${humanDuration(Math.round(crash.uptimeBeforeCrashMs / 1000))}`);
  }
  return bits.join(" · ");
}

export function formatMachineStateText(data, config, runtime) {
  const stamp = formatStamp(new Date(), data?.offset);
  const lines = [];

  lines.push(`时间      ${stamp.clock} ${stamp.offset}（${stamp.weekday}，${data?.timeZone || "?"}）`);
  lines.push(`电源      ${describePower(data, config)}`);
  if (data?.battery?.present) {
    const b = data.battery;
    const extra = [];
    if (b.name) extra.push(`型号 ${b.name}`);
    if (b.healthPercent !== null && b.healthPercent !== undefined) {
      extra.push(`电池健康 ${b.healthPercent}%（满充 ${b.fullChargeCapacityMWh} / 设计 ${b.designCapacityMWh} mWh）`);
    }
    if (extra.length) lines.push(`电池      ${extra.join(" · ")}`);
  }

  const scheme = data?.powerScheme;
  if (scheme) {
    const name = scheme.name || "未识别";
    const tail = scheme.guid ? `（${scheme.guid}）` : "";
    const others = Array.isArray(scheme.all) && scheme.all.length > 1
      ? ` · 共 ${scheme.all.length} 个方案：${scheme.all.map((s) => `${s.name}${s.active ? "(当前)" : ""}`).join("、")}`
      : "";
    lines.push(`电源计划  ${name}${tail}${others}`);
  }

  const sys = data?.system;
  if (sys) {
    lines.push(`运行时长  ${humanDuration(sys.uptimeSeconds)}`);
    lines.push(`负载      CPU ${sys.cpuLoadPercent === null || sys.cpuLoadPercent === undefined ? "?" : `${sys.cpuLoadPercent}%`}（瞬时） · 内存 ${sys.memoryUsedPercent}%（${sys.memoryUsedGB} / ${sys.memoryTotalGB} GB）`);
    if (Array.isArray(sys.disks) && sys.disks.length) {
      const diskText = sys.disks
        .map((d) => `${d.name} 剩 ${d.freeGB} GB / ${d.totalGB} GB（已用 ${d.usedPercent}%）`)
        .join("   ");
      lines.push(`磁盘      ${diskText}`);
    }
  }

  if (Array.isArray(data?.hana) && data.hana.length) {
    const parts = data.hana.map((p) => {
      if (!p.running) return `${p.name} 未运行`;
      const mem = p.memoryMB === null || p.memoryMB === undefined ? "?" : `${p.memoryMB} MB`;
      const up = p.uptimeSeconds === null || p.uptimeSeconds === undefined ? "" : ` · 已运行 ${humanDuration(p.uptimeSeconds)}`;
      const count = p.processCount > 1 ? `（${p.processCount} 进程）` : "";
      return `${p.name} ${mem}${count}${up}`;
    });
    lines.push("Hana      " + parts[0]);
    for (const rest of parts.slice(1)) lines.push("          " + rest);
  }

  if (Array.isArray(data?.topMemoryProcesses) && data.topMemoryProcesses.length) {
    const top = data.topMemoryProcesses.map((p) => `${p.name} ${p.memoryMB} MB`).join(" · ");
    lines.push(`内存前五  ${top}`);
  }

  if (runtime?.lastCrash) {
    lines.push(`上次崩溃  ${describeCrash(runtime.lastCrash)}`);
  }

  const warnings = collectWarnings(data, config);
  if (warnings.length) {
    lines.push("");
    for (const w of warnings) lines.push(`注意      ${w}`);
    // auto 模式只有 extension 能看见模型，工具层仅在 always 下追加
    if (config?.encouragement?.mode === "always") {
      const encText = (config.encouragement.text || "").trim() || (config.texts?.encouragement || "").trim();
      const batteryWarned = data?.battery?.present !== false && batteryLevel(data?.battery, config) !== "ok";
      if (encText && batteryWarned) lines.push(`鼓励      ${encText}`);
    }
  }

  return lines.join("\n");
}
