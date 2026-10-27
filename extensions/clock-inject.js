/**
 * 时钟注入 extension
 *
 * 两件事：
 *
 * 1. 工具返回时按间隔追加一行当前时间，顺带捎上电量；电量吃紧且模型属于
 *    “见到资源紧张就缩手”的类型时，再补一句鼓励。
 *
 * 2. 会话启动时检查上一轮 server 是不是崩过。崩过就递一张便条，让 agent 知道
 *    自己的上下文可能断了一截，别装作记得完整过程。便条 user invisible，用
 *    sendMessage 的 display:false 塞进去，只提醒一次。
 */
import { readConfigFromFile, resolveExtensionDataDir } from "../lib/settings.js";
import {
  readVitals,
  vitalsSummary,
  batteryLevel,
  humanDuration,
  formatStamp,
} from "../lib/system-state.js";
import { fillTemplate, pickEncouragement } from "../lib/text.js";
import { peekPendingCrash, takePendingCrash } from "../lib/runtime-watch.js";

const TAG = "[pc-status]";

function buildCrashNotice(crash) {
  const lines = [];
  const beatAt = crash.lastHeartbeatAt ? new Date(crash.lastHeartbeatAt) : null;
  const stamp = beatAt && !Number.isNaN(beatAt.getTime()) ? formatStamp(beatAt) : null;

  lines.push("<pc-status-crash-notice>");
  lines.push("上一轮 hana-server 不是正常退出的，它在运行中直接断掉了。");
  if (stamp) lines.push(`最后心跳时间：${stamp.clock} ${stamp.offset}`);
  if (typeof crash.gapMs === "number") {
    lines.push(`中断约 ${humanDuration(Math.round(crash.gapMs / 1000))} 后重新启动。`);
  }
  if (typeof crash.uptimeBeforeCrashMs === "number" && crash.uptimeBeforeCrashMs > 0) {
    lines.push(`崩溃前这次运行已经持续了 ${humanDuration(Math.round(crash.uptimeBeforeCrashMs / 1000))}。`);
  }
  lines.push("");
  lines.push("这意味着上一段工作可能在你不知道的地方停住了：任务可能做到一半，工具输出可能没写完，");
  lines.push("对话记录的末尾也可能缺了一截。在接着往下做之前，先确认上次进行到哪一步，");
  lines.push("不要假设自己还记得完整过程。如果用户没提这件事，可以顺口问一句要不要先对一下进度。");
  lines.push("</pc-status-crash-notice>");
  return lines.join("\n");
}

export default function clockInjectExtension(pi) {
  // 每个 session 一份实例，状态天然按会话隔离
  let lastInjectedAt = 0;
  let lastToolStartedAt = 0;

  // ── 崩溃后递便条 ──
  pi.on("session_start", () => {
    setTimeout(() => {
      try {
        const dataDir = resolveExtensionDataDir();
        if (!readConfigFromFile(dataDir).crashNoticeEnabled) {
          // 用户关掉了提醒，也不再积压
          takePendingCrash(dataDir);
          return;
        }
        const crash = peekPendingCrash(dataDir);
        if (!crash) return;

        if (typeof pi.sendMessage !== "function") return;

        pi.sendMessage(
          {
            customType: "pc-status-crash-notice",
            content: buildCrashNotice(crash),
            display: false,
          },
          { deliverAs: "steer", triggerTurn: false },
        );

        // 递成功才消费，失败就留着下次再试
        takePendingCrash(dataDir);
      } catch (err) {
        try {
          console.error(`${TAG} crash notice failed: ${err && err.message ? err.message : err}`);
        } catch {
          /* ignore */
        }
      }
    }, 500);
  });

  // ── 时钟与电量 ──
  pi.on("tool_call", () => {
    lastToolStartedAt = Date.now();
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!event || !Array.isArray(event.content)) return undefined;

      const config = readConfigFromFile(resolveExtensionDataDir());
      const texts = config.texts || {};
      const notes = [];
      const now = Date.now();

      const intervalMs = Math.max(1, Number(config.clockIntervalMinutes) || 10) * 60 * 1000;
      if (config.clockInjectEnabled && now - lastInjectedAt >= intervalMs) {
        lastInjectedAt = now;
        const stamp = formatStamp(new Date());

        let vitalsText = null;
        let level = "ok";
        if (config.includeVitalsInClock) {
          const vitals = await readVitals();
          if (vitals.ok) {
            vitalsText = vitalsSummary(vitals.data, config);
            level = batteryLevel(vitals.data, config);
          }
        }

        const vitalsSuffix = vitalsText ? fillTemplate(texts.clockVitalsSuffix, { vitals: vitalsText }) : "";
        notes.push(
          fillTemplate(texts.clockLine, {
            clock: stamp.clock,
            offset: stamp.offset,
            weekday: stamp.weekday,
            vitals: vitalsText || "",
            vitalsSuffix,
          }),
        );

        // 电量吃紧时，看模型脸色补一句
        if (level === "low" || level === "critical") {
          const encouragement = pickEncouragement(config, ctx);
          if (encouragement) notes.push(`${TAG} ${encouragement.text}`);
        }
      }

      const slowThreshold = Number(config.reportSlowToolSeconds) || 0;
      if (slowThreshold > 0 && lastToolStartedAt > 0) {
        const elapsedSec = Math.round((now - lastToolStartedAt) / 1000);
        if (elapsedSec >= slowThreshold) {
          notes.push(
            fillTemplate(texts.slowTool, {
              tool: event.toolName || "工具",
              seconds: elapsedSec,
              elapsed: humanDuration(elapsedSec),
            }),
          );
        }
      }

      if (notes.length === 0) return undefined;

      const text = notes.map((note) => `\n${note}`).join("");
      return { content: [...event.content, { type: "text", text }] };
    } catch (err) {
      // 注入是旁路能力，任何异常都只能吞掉，不能影响工具本身的返回
      try {
        console.error(`${TAG} clock inject failed: ${err && err.message ? err.message : err}`);
      } catch {
        /* ignore */
      }
      return undefined;
    }
  });
}
