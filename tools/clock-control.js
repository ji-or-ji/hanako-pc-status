/**
 * clock_control：查看与修改告警阈值、文案、以及时钟注入行为。
 *
 * 无参数调用返回当前完整配置；带参数时合并写入插件数据目录下的 clock.json。
 * 配置会在下一次注入 / 下一次 machine_state 调用时被读到。
 */
import {
  readConfigWithSource,
  writeConfig,
  resolveTextKey,
  textKeyPairs,
  DEFAULT_TEXTS,
  DEFAULT_THRESHOLDS,
} from "../lib/settings.js";

export const name = "clock_control";
export const description =
  "查看或修改 PC Status 的全部设置：时钟注入开关与间隔、是否附带电量、慢调用提示阈值；"
  + "电量低/危急线、内存告警线、磁盘剩余告警线、hana-server 内存告警线；"
  + "以及每一条告警文案和注入行的文本模板。不带参数调用即查看当前设置。";

export const parameters = {
  type: "object",
  properties: {
    enabled: {
      type: "boolean",
      description: "是否启用时钟注入",
    },
    intervalMinutes: {
      type: "number",
      description: "两次注入之间的最小间隔，单位分钟，范围 1 到 480",
    },
    includeVitals: {
      type: "boolean",
      description: "注入时是否附带电量与供电状态",
    },
    reportSlowToolSeconds: {
      type: "number",
      description: "单次工具调用超过多少秒时附带耗时提示，0 表示关闭",
    },
    crashNoticeEnabled: {
      type: "boolean",
      description: "hana-server 上一轮异常终止时，在下一次会话开始时提醒 agent",
    },
    networkWatchEnabled: {
      type: "boolean",
      description: "是否监测网络状态切换（变化后下一次工具调用就提示，断得久时下次会话再提醒）",
    },
    networkProbeIntervalSeconds: {
      type: "number",
      description: "网络探测间隔，单位秒，范围 10 到 300",
    },
    networkOutageThresholdMinutes: {
      type: "number",
      description: "断网超过多少分钟算一次「被打断」，恢复后会在下次会话提醒",
    },
    batteryLowPercent: {
      type: "number",
      description: "电量低于或等于这个百分比算偏低，默认 30",
    },
    batteryCriticalPercent: {
      type: "number",
      description: "电量低于或等于这个百分比算危急，默认 10",
    },
    memoryHighPercent: {
      type: "number",
      description: "内存使用率高于或等于这个百分比告警，默认 92",
    },
    diskLowGB: {
      type: "number",
      description: "任一磁盘剩余空间低于这个 GB 数告警，默认 5",
    },
    serverMemoryHighMB: {
      type: "number",
      description: "hana-server 占用超过这个 MB 数告警，默认 2048",
    },
    texts: {
      type: "object",
      description:
        "要覆盖的文案。键名两种写法都行：内部名 batteryLowCharging，或设置界面里的 textBatteryLowCharging。"
        + "可用键：batteryCritical、batteryLowDischarging、batteryLowCharging、memoryHigh、diskLow、"
        + "serverMissing、serverHeavy、clockLine、clockVitalsSuffix、slowTool、encouragement。"
        + "只需传要改的那几条，其余保持不变。",
      additionalProperties: { type: "string" },
    },
    resetTexts: {
      type: "boolean",
      description: "把所有文案恢复成默认值",
    },
    resetThresholds: {
      type: "boolean",
      description: "把所有阈值恢复成默认值",
    },
    encouragementMode: {
      type: "string",
      enum: ["auto", "always", "off"],
      description:
        "鼓励语时机。auto：只在检测到匹配模型时追加（默认，靠 extension 拿到的当前模型判断）；"
        + "always：电量偏低就追加，不看模型；off：关闭",
    },
    encouragementText: {
      type: "string",
      description: "鼓励语文案，留空则用 texts.encouragement",
    },
    encouragementModels: {
      type: "array",
      items: { type: "string" },
      description: 'auto 模式下匹配哪些模型，默认 ["deepseek"]，按子串匹配模型标识',
    },
  },
};

export const sessionPermission = {
  readOnly: false,
  auto: "allow",
  description: "只写入插件自己的数据目录，不触碰用户文件",
};

const PLACEHOLDERS = [
  ["{percent}", "电量百分比"],
  ["{usedPercent}", "内存占用百分比"],
  ["{disk}", "磁盘盘符"],
  ["{freeGB}", "磁盘剩余 GB"],
  ["{memoryMB}", "进程占用 MB"],
  ["{clock}", "年月日 时分秒"],
  ["{offset}", "时区偏移等 +08:00"],
  ["{weekday}", "周几"],
  ["{vitals}", "电量摘要纯文本"],
  ["{vitalsSuffix}", "带前导分隔符的电量摘要"],
  ["{tool}", "工具名"],
  ["{elapsed}", "耗时的人话表述"],
  ["{seconds}", "耗时秒数"],
];

function render(config, source) {
  const t = config.thresholds;
  const lines = [];

  lines.push(`配置来源  ${source === "store" ? "插件配置存储（设置界面同一份）" : "config.json 文件"}`);
  lines.push("");
  lines.push("时钟注入");
  lines.push(`  启用            ${config.clockInjectEnabled ? "是" : "否"}`);
  lines.push(`  注入间隔        ${config.clockIntervalMinutes} 分钟`);
  lines.push(`  附带电量        ${config.includeVitalsInClock ? "是" : "否"}`);
  lines.push(`  慢调用提示      ${config.reportSlowToolSeconds > 0 ? `超过 ${config.reportSlowToolSeconds} 秒时提示` : "关闭"}`);
  lines.push(`  崩溃后提醒      ${config.crashNoticeEnabled ? "开" : "关"}`);
  lines.push(`  网络监测        ${config.networkWatchEnabled ? `开，每 ${config.networkProbeIntervalSeconds} 秒探一次` : "关"}`);
  lines.push(`  断网提醒阈值    ${config.networkOutageThresholdMinutes} 分钟`);

  lines.push("");
  lines.push("阈值");
  lines.push(`  电量偏低        <= ${t.batteryLow}%`);
  lines.push(`  电量危急        <= ${t.batteryCritical}%`);
  lines.push(`  内存告警        >= ${t.memoryHigh}%`);
  lines.push(`  磁盘告警        低于 ${t.diskLowGB} GB`);
  lines.push(`  hana-server     > ${t.serverMemoryHighMB} MB`);

  lines.push("");
  lines.push("文案");
  lines.push("  （工具里用左侧短名，设置界面里对应的键是 text + 首字母大写，如 batteryLowCharging ↔ textBatteryLowCharging）");
  for (const pair of textKeyPairs()) {
    lines.push(`  ${pair.internal.padEnd(22)}${config.texts[pair.internal]}`);
  }

  lines.push("");
  lines.push("鼓励语");
  const enc = config.encouragement;
  lines.push(`  时机            ${enc.mode === "auto" ? "电量偏低且模型匹配" : enc.mode === "always" ? "电量偏低即追加" : "关闭"}`);
  lines.push(`  匹配模型        ${enc.matchModels.join("、") || "（无）"}`);
  lines.push(`  内容            ${(enc.text || "").trim() || "（沿用 texts.encouragement）"}`);

  lines.push("");
  lines.push("可用占位符");
  lines.push("  " + PLACEHOLDERS.map(([k, v]) => `${k} ${v}`).join("   "));

  return lines.join("\n");
}

function buildThresholdPatch(input) {
  const patch = {};
  const map = {
    batteryLowPercent: "batteryLow",
    batteryCriticalPercent: "batteryCritical",
    memoryHighPercent: "memoryHigh",
    diskLowGB: "diskLowGB",
    serverMemoryHighMB: "serverMemoryHighMB",
  };
  for (const [param, key] of Object.entries(map)) {
    if (typeof input[param] === "number" && Number.isFinite(input[param])) {
      patch[key] = input[param];
    }
  }
  return patch;
}

export async function execute(input = {}, toolCtx) {
  const { config: current, source } = readConfigWithSource(toolCtx);
  const patch = {};

  if (typeof input.enabled === "boolean") patch.clockInjectEnabled = input.enabled;
  if (typeof input.intervalMinutes === "number" && Number.isFinite(input.intervalMinutes)) {
    patch.clockIntervalMinutes = input.intervalMinutes;
  }
  if (typeof input.includeVitals === "boolean") patch.includeVitalsInClock = input.includeVitals;
  if (typeof input.reportSlowToolSeconds === "number" && Number.isFinite(input.reportSlowToolSeconds)) {
    patch.reportSlowToolSeconds = input.reportSlowToolSeconds;
  }
  if (typeof input.crashNoticeEnabled === "boolean") patch.crashNoticeEnabled = input.crashNoticeEnabled;
  if (typeof input.networkWatchEnabled === "boolean") patch.networkWatchEnabled = input.networkWatchEnabled;
  if (typeof input.networkProbeIntervalSeconds === "number" && Number.isFinite(input.networkProbeIntervalSeconds)) {
    patch.networkProbeIntervalSeconds = input.networkProbeIntervalSeconds;
  }
  if (typeof input.networkOutageThresholdMinutes === "number" && Number.isFinite(input.networkOutageThresholdMinutes)) {
    patch.networkOutageThresholdMinutes = input.networkOutageThresholdMinutes;
  }

  if (input.resetThresholds === true) {
    patch.thresholds = { ...DEFAULT_THRESHOLDS };
  } else {
    const thresholdPatch = buildThresholdPatch(input);
    if (Object.keys(thresholdPatch).length) patch.thresholds = thresholdPatch;
  }

  if (input.resetTexts === true) {
    patch.texts = { ...DEFAULT_TEXTS };
  } else if (input.texts && typeof input.texts === "object" && !Array.isArray(input.texts)) {
    const textPatch = {};
    for (const [rawKey, value] of Object.entries(input.texts)) {
      if (typeof value !== "string") continue;
      const internalKey = resolveTextKey(rawKey);
      if (!internalKey) continue;
      textPatch[internalKey] = value;
    }
    if (Object.keys(textPatch).length) patch.texts = textPatch;
  }

  const encPatch = {};
  if (input.encouragementMode && ["auto", "always", "off"].includes(input.encouragementMode)) {
    encPatch.mode = input.encouragementMode;
  }
  if (typeof input.encouragementText === "string") encPatch.text = input.encouragementText;
  if (Array.isArray(input.encouragementModels)) {
    encPatch.matchModels = input.encouragementModels.filter((m) => typeof m === "string" && m.trim());
  }
  if (Object.keys(encPatch).length) patch.encouragement = encPatch;

  if (Object.keys(patch).length === 0) {
    return render(current, source);
  }

  const next = writeConfig(toolCtx, patch);
  return `已更新。\n\n${render(next, source)}`;
}
