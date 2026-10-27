/**
 * 插件配置读写。
 *
 * Hana 的插件配置落在 `${HANA_HOME}/plugin-data/{pluginId}/config.json`，
 * 结构可能是扁平 map，也可能是 `{ schemaVersion, global, agents, sessions }` 分层。
 * 两种都认。
 *
 * 两条读取路径：
 * - 工具里优先用 toolCtx.config（Hana 的配置存储，和设置界面共用同一份内存与文件）
 * - extension 拿不到 ctx，直接读文件（只读，不写入，避免与存储层抢写）
 *
 * 对外统一成交互用的嵌套结构（thresholds / texts / encouragement），
 * 存盘时摊平成扁平键，这样 manifest 里的 JSON Schema 才能逐项渲染成表单。
 */
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export const PLUGIN_ID = "pc-status";
export const CONFIG_FILENAME = "config.json";
export const LEGACY_FILENAME = "clock.json";

/** 告警阈值，改这里就改了“多低算低” */
export const DEFAULT_THRESHOLDS = Object.freeze({
  batteryLow: 30,
  batteryCritical: 10,
  memoryHigh: 92,
  diskLowGB: 5,
  serverMemoryHighMB: 2048,
});

/** 所有可自定义文案。占位符用 {name}，未知占位符原样保留 */
export const DEFAULT_TEXTS = Object.freeze({
  batteryCritical: "电量仅 {percent}%，随时可能关机，长任务有中断风险",
  batteryLowDischarging: "电量 {percent}% 且未接电源，建议先接电源再跑长任务",
  batteryLowCharging: "电量 {percent}%，正在充电但还没脱离低电量区间",
  memoryHigh: "内存吃紧，已用 {usedPercent}%，大文件操作或长会话容易卡顿",
  diskLow: "{disk} 只剩 {freeGB} GB，写大文件前先清理",
  serverMissing: "hana-server 没在运行，工具与 Agent 能力可能已失效",
  serverHeavy: "hana-server 占用 {memoryMB} MB，内存压力偏大",
  clockLine: "[pc-status] 时钟 {clock} {offset} {weekday}{vitalsSuffix}",
  clockVitalsSuffix: " · {vitals}",
  slowTool: "[pc-status] 本次 {tool} 调用耗时 {elapsed}",
  encouragement: "资源紧张只是提醒，不影响执行：按原计划完整做完，不要缩减输出。",
});

export const DEFAULT_CONFIG = Object.freeze({
  clockInjectEnabled: true,
  clockIntervalMinutes: 10,
  includeVitalsInClock: true,
  reportSlowToolSeconds: 60,
  crashNoticeEnabled: true,
  thresholds: DEFAULT_THRESHOLDS,
  texts: DEFAULT_TEXTS,
  encouragement: {
    // auto：只在检测到匹配的模型时追加；always：无条件追加；off：关闭
    mode: "auto",
    matchModels: ["deepseek"],
    // 留空则用 texts.encouragement
    text: "",
  },
});

/** 内部字段名 → config.json 里的扁平键 */
const TEXT_FLAT = Object.freeze({
  batteryCritical: "textBatteryCritical",
  batteryLowDischarging: "textBatteryLowDischarging",
  batteryLowCharging: "textBatteryLowCharging",
  memoryHigh: "textMemoryHigh",
  diskLow: "textDiskLow",
  serverMissing: "textServerMissing",
  serverHeavy: "textServerHeavy",
  clockLine: "textClockLine",
  clockVitalsSuffix: "textClockVitalsSuffix",
  slowTool: "textSlowTool",
  encouragement: "textEncouragement",
});

/**
 * 文案键的両种写法都认：内部名 batteryLowCharging、扁平名 textBatteryLowCharging。
 * 因为设置界面用扁平键，工具参数里用内部名更自然，不统一容易踩坑。
 */
export function resolveTextKey(key) {
  if (typeof key !== "string" || !key) return null;
  if (Object.prototype.hasOwnProperty.call(DEFAULT_TEXTS, key)) return key;
  for (const [internal, flat] of Object.entries(TEXT_FLAT)) {
    if (flat === key) return internal;
  }
  if (key.startsWith("text") && key.length > 4) {
    const tail = key.slice(4);
    const lower = tail.charAt(0).toLowerCase() + tail.slice(1);
    if (Object.prototype.hasOwnProperty.call(DEFAULT_TEXTS, lower)) return lower;
  }
  return null;
}

export function hanaHome() {
  return process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
}

export function resolveDataDir(toolCtx) {
  if (toolCtx && typeof toolCtx.dataDir === "string" && toolCtx.dataDir) return toolCtx.dataDir;
  return path.join(hanaHome(), "plugin-data", PLUGIN_ID);
}

/**
 * extension 拿不到 ctx，只能自己找目录。开发态插件的数据在
 * `plugin-data/dev/{id}/`，正式插件在 `plugin-data/{id}/`，两边都看一眼。
 * 判断依据不只是配置文件：心跳记录也会落在同一个目录里。
 */
export function resolveExtensionDataDir() {
  const base = hanaHome();
  const primary = path.join(base, "plugin-data", PLUGIN_ID);
  const devPath = path.join(base, "plugin-data", "dev", PLUGIN_ID);
  const markers = [CONFIG_FILENAME, "runtime-state.json", "pending-crash.json"];

  const probe = (dir) => {
    let found = false;
    let newest = 0;
    for (const name of markers) {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      found = true;
      try {
        newest = Math.max(newest, statSync(file).mtimeMs);
      } catch {
        /* 读不到时间就忽略 */
      }
    }
    return { found, newest };
  };

  const a = probe(primary);
  const b = probe(devPath);
  if (a.found && b.found) return b.newest > a.newest ? devPath : primary;
  if (b.found) return devPath;
  return primary;
}

/** 兼容旧名字 */
export const resolveConfigDirForExtension = resolveExtensionDataDir;

export function configPath(dataDir) {
  return path.join(dataDir || resolveDataDir(null), CONFIG_FILENAME);
}

/** 文案键名对照，给设置界面与工具输出共用 */
export function textKeyPairs() {
  return Object.entries(TEXT_FLAT).map(([internal, flat]) => ({ internal, flat }));
}

function toNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** 扁平键 map → 内部嵌套结构（缺少的键用默认值补齐） */
export function normalizeConfig(flatRaw) {
  const flat = flatRaw && typeof flatRaw === "object" && !Array.isArray(flatRaw) ? flatRaw : {};

  const thresholds = {
    batteryLow: toNumber(flat.batteryLowPercent, DEFAULT_THRESHOLDS.batteryLow, 1, 100),
    batteryCritical: toNumber(flat.batteryCriticalPercent, DEFAULT_THRESHOLDS.batteryCritical, 0, 100),
    memoryHigh: toNumber(flat.memoryHighPercent, DEFAULT_THRESHOLDS.memoryHigh, 1, 100),
    diskLowGB: toNumber(flat.diskLowGB, DEFAULT_THRESHOLDS.diskLowGB, 0),
    serverMemoryHighMB: toNumber(flat.serverMemoryHighMB, DEFAULT_THRESHOLDS.serverMemoryHighMB, 0),
  };
  // 危急线高于低位线时告警顺序会失去意义，直接压回
  if (thresholds.batteryCritical > thresholds.batteryLow) thresholds.batteryCritical = thresholds.batteryLow;

  const texts = {};
  for (const [internalKey, flatKey] of Object.entries(TEXT_FLAT)) {
    const value = flat[flatKey];
    texts[internalKey] = typeof value === "string" ? value : DEFAULT_TEXTS[internalKey];
  }

  const rawModels = flat.encouragementModels;
  let matchModels;
  if (Array.isArray(rawModels)) {
    matchModels = rawModels.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim());
  } else if (typeof rawModels === "string") {
    matchModels = rawModels.split(/[,，\s]+/).map((m) => m.trim()).filter(Boolean);
  } else {
    matchModels = [...DEFAULT_CONFIG.encouragement.matchModels];
  }

  const mode = flat.encouragementMode === "always" || flat.encouragementMode === "off" ? flat.encouragementMode : "auto";

  return {
    clockInjectEnabled: flat.clockInjectEnabled !== false,
    clockIntervalMinutes: toNumber(flat.clockIntervalMinutes, DEFAULT_CONFIG.clockIntervalMinutes, 1, 480),
    includeVitalsInClock: flat.includeVitalsInClock !== false,
    reportSlowToolSeconds: toNumber(flat.reportSlowToolSeconds, DEFAULT_CONFIG.reportSlowToolSeconds, 0),
    crashNoticeEnabled: flat.crashNoticeEnabled !== false,
    thresholds,
    texts,
    encouragement: {
      mode,
      matchModels: matchModels.length ? matchModels : [...DEFAULT_CONFIG.encouragement.matchModels],
      text: typeof flat.encouragementText === "string" ? flat.encouragementText : "",
    },
  };
}

/** 内部嵌套结构 → 扁平键 map（写回 config.json 用） */
export function toFlat(config) {
  const flat = {
    clockInjectEnabled: config.clockInjectEnabled,
    clockIntervalMinutes: config.clockIntervalMinutes,
    includeVitalsInClock: config.includeVitalsInClock,
    reportSlowToolSeconds: config.reportSlowToolSeconds,
    crashNoticeEnabled: config.crashNoticeEnabled,
    batteryLowPercent: config.thresholds.batteryLow,
    batteryCriticalPercent: config.thresholds.batteryCritical,
    memoryHighPercent: config.thresholds.memoryHigh,
    diskLowGB: config.thresholds.diskLowGB,
    serverMemoryHighMB: config.thresholds.serverMemoryHighMB,
    encouragementMode: config.encouragement.mode,
    encouragementText: config.encouragement.text,
    encouragementModels: config.encouragement.matchModels.join(","),
  };
  for (const [internalKey, flatKey] of Object.entries(TEXT_FLAT)) {
    flat[flatKey] = config.texts[internalKey];
  }
  return flat;
}

/** 从配置文件里挖出扁平值，兼容分层与扁平两种结构 */
function extractFlat(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.global && typeof raw.global === "object" && !Array.isArray(raw.global)) return raw.global;
    return raw;
  }
  return {};
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 直接读文件（extension 用，只读） */
export function readConfigFromFile(dataDir) {
  const dir = dataDir || resolveDataDir(null);
  const raw = readJson(configPath(dir));
  if (raw) return normalizeConfig(extractFlat(raw));

  // 旧版用的是 clock.json 的嵌套结构，读一次做兼容
  const legacy = readJson(path.join(dir, LEGACY_FILENAME));
  if (legacy) {
    const merged = {
      clockInjectEnabled: legacy.clockInjectEnabled,
      clockIntervalMinutes: legacy.clockIntervalMinutes,
      includeVitalsInClock: legacy.includeVitalsInClock,
      reportSlowToolSeconds: legacy.reportSlowToolSeconds,
      batteryLowPercent: legacy.thresholds?.batteryLow,
      batteryCriticalPercent: legacy.thresholds?.batteryCritical,
      memoryHighPercent: legacy.thresholds?.memoryHigh,
      diskLowGB: legacy.thresholds?.diskLowGB,
      serverMemoryHighMB: legacy.thresholds?.serverMemoryHighMB,
      encouragementMode: legacy.encouragement?.mode,
      encouragementText: legacy.encouragement?.text,
      encouragementModels: Array.isArray(legacy.encouragement?.matchModels)
        ? legacy.encouragement.matchModels.join(",")
        : undefined,
    };
    for (const [internalKey, flatKey] of Object.entries(TEXT_FLAT)) {
      merged[flatKey] = legacy.texts?.[internalKey];
    }
    return normalizeConfig(merged);
  }

  return normalizeConfig({});
}

/**
 * 优先走 Hana 的插件配置存储（与设置界面同一份），没有就退回读文件。
 * 返回 { config, source }
 */
export function readConfigWithSource(toolCtx) {
  if (toolCtx?.config?.getAll) {
    try {
      const values = toolCtx.config.getAll() || {};
      return { config: normalizeConfig(values), source: "store" };
    } catch {
      /* 存储不可用时退回文件 */
    }
  }
  return { config: readConfigFromFile(resolveDataDir(toolCtx)), source: "file" };
}

export function readConfig(toolCtxOrDir) {
  if (typeof toolCtxOrDir === "string") return readConfigFromFile(toolCtxOrDir);
  return readConfigWithSource(toolCtxOrDir).config;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined || value === null) continue;
    if (
      value && typeof value === "object" && !Array.isArray(value)
      && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 写入配置。有 toolCtx.config 就走存储层（设置界面同步刷新），
 * 否则直接写文件（本地测试用）。
 */
export function writeConfig(toolCtxOrDir, patch) {
  const usingCtx = Boolean(toolCtxOrDir?.config?.setMany);
  const dataDir = usingCtx ? resolveDataDir(toolCtxOrDir) : resolveDataDir(null);
  const target = typeof toolCtxOrDir === "string" ? toolCtxOrDir : dataDir;

  const current = typeof toolCtxOrDir === "string"
    ? readConfigFromFile(target)
    : readConfigWithSource(toolCtxOrDir).config;

  const next = normalizeConfig(toFlat(deepMerge(current, patch || {})));

  if (usingCtx) {
    toolCtxOrDir.config.setMany(toFlat(next));
    return next;
  }

  mkdirSync(target, { recursive: true });
  const file = configPath(target);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(toFlat(next), null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return next;
}
