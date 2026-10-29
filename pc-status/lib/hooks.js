/**
 * 会话钩子：工具返回时追加旁注，回合开始前递便条。
 *
 * v1 这条链路写在 Pi extension 里（extensions/clock-inject.js），靠 pi.on("tool_result")
 * 与 pi.on("session_start")。v2 里对应的是 ctx.hooks：
 * - tools/pre-execute  记一下调用开始时间（算慢调用）
 * - tools/post-execute 追加旁注（时钟、电量、网络变动、慢调用）
 * - agent/before-start 把「上一段会话期间断网较久」的便条塞进本轮
 *
 * v1 还有一条「hana-server 崩了就先对一下进度」的便条，v2 不再提供：AppHost 里拿不到
 * 正常退出信号（宿主直接杀进程，Windows 上连 SIGTERM 处理器都不走），取消它就等于把
 * 每次正常退出都报成崩溃。宁可不报，也不报错。
 */
import { fillTemplate, pickEncouragement } from "./text.js";
import { readVitals, vitalsSummary, batteryLevel, humanDuration, formatStamp } from "./system-state.js";
import { takePendingEvents, takePendingOutage } from "./network-watch.js";

const TAG = "[pc-status]";

function buildOutageNotice(outage) {
  const lines = [];
  const started = outage.startedAt ? new Date(outage.startedAt) : null;
  const ended = outage.endedAt ? new Date(outage.endedAt) : null;
  const startStamp = started && !Number.isNaN(started.getTime()) ? formatStamp(started) : null;
  const endStamp = ended && !Number.isNaN(ended.getTime()) ? formatStamp(ended) : null;

  lines.push("<pc-status-network-notice>");
  lines.push("上一段会话期间网络断过一段时间。");
  if (startStamp && endStamp) {
    lines.push(`从 ${startStamp.clock} 到 ${endStamp.clock}，约 ${humanDuration(Math.round((outage.outageMs || 0) / 1000))}。`);
  } else if (outage.outageMs) {
    lines.push(`中断约 ${humanDuration(Math.round(outage.outageMs / 1000))}。`);
  }
  lines.push("");
  lines.push("断网期间需要联网的操作（抓网页、拉仓库、调模型）会失败或超时，");
  lines.push("上一轮对话可能因此断在中途。继续之前先确认上次进行到哪一步，");
  lines.push("不要把断网造成的缺失当成任务已经完成。");
  lines.push("</pc-status-network-notice>");
  return lines.join("\n");
}

/** 把一条网络变动事件渲染成一行旁注 */
function renderNetworkEvent(event, texts) {
  const wasOffline = event.from?.status === "offline";
  const nowOffline = event.to?.status === "offline";

  if (nowOffline) return fillTemplate(texts.networkOffline, { reason: "探测失败" });
  if (wasOffline && !nowOffline) {
    const duration = event.outageMs ? humanDuration(Math.round(event.outageMs / 1000)) : "短暂";
    return fillTemplate(texts.networkOnline, { duration });
  }
  return null;
}

/** v2 拿不到 Pi 的会话对象，改问一次 session:get 要模型标识；拿不到就当作未知。 */
async function sessionModelLabel(sdk, sessionId) {
  if (!sessionId) return null;
  try {
    const snapshot = await sdk.bus.request("session:get", { sessionId });
    const id = snapshot?.modelId || snapshot?.model?.modelId || snapshot?.model?.id || "";
    const provider = snapshot?.modelProvider || snapshot?.model?.provider || "";
    const label = [provider, id].filter((v) => typeof v === "string" && v.trim()).join(" ");
    return label || null;
  } catch {
    return null;
  }
}

async function onToolResult(sdk, runtime, invocation) {
  try {
    const content = Array.isArray(invocation?.content) ? invocation.content : [];
    const cfg = await runtime.config();
    const texts = cfg.texts || {};
    const notes = [];
    const now = Date.now();

    // 网络变动：变化后的下一次工具调用就提示，不受时钟节流限制
    const netEvents = takePendingEvents(sdk.dataDir);
    if (netEvents.length && cfg.networkWatchEnabled) {
      const rendered = renderNetworkEvent(netEvents[netEvents.length - 1], texts);
      if (rendered) notes.push(rendered);
      if (netEvents.length > 1) notes.push(`[pc-status] 网络状态连续变动 ${netEvents.length} 次`);
    }

    const intervalMs = Math.max(1, Number(cfg.clockIntervalMinutes) || 10) * 60 * 1000;
    if (cfg.clockInjectEnabled && now - runtime.state.lastInjectedAt >= intervalMs) {
      runtime.state.lastInjectedAt = now;
      const stamp = formatStamp(new Date());

      let vitalsText = null;
      let level = "ok";
      if (cfg.includeVitalsInClock) {
        const vitals = await readVitals();
        if (vitals.ok) {
          vitalsText = vitalsSummary(vitals.data, cfg);
          level = batteryLevel(vitals.data, cfg);
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
        const label = await sessionModelLabel(sdk, invocation?.session?.sessionId);
        const encouragement = pickEncouragement(cfg, label ? { model: label } : null);
        if (encouragement) notes.push(`${TAG} ${encouragement.text}`);
      }
    }

    const slowThreshold = Number(cfg.reportSlowToolSeconds) || 0;
    if (slowThreshold > 0 && runtime.state.lastToolStartedAt > 0) {
      const elapsedSec = Math.round((now - runtime.state.lastToolStartedAt) / 1000);
      if (elapsedSec >= slowThreshold) {
        notes.push(
          fillTemplate(texts.slowTool, {
            tool: invocation?.toolName || "工具",
            seconds: elapsedSec,
            elapsed: humanDuration(elapsedSec),
          }),
        );
      }
    }

    if (notes.length === 0) return undefined;

    const text = notes.map((note) => `\n${note}`).join("");
    return { content: [...content, { type: "text", text }] };
  } catch (err) {
    // 注入是旁路能力，任何异常都只能吞掉，不能影响工具本身的返回
    await sdk.logger.warn(`clock inject failed: ${err?.message || err}`);
    return undefined;
  }
}

async function onBeforeStart(sdk, runtime) {
  try {
    const outage = takePendingOutage(sdk.dataDir);
    if (!outage) return undefined;
    const cfg = await runtime.config();
    if (!cfg.networkWatchEnabled) return undefined;
    return {
      message: {
        customType: "pc-status-network-notice",
        content: buildOutageNotice(outage),
        display: false,
      },
    };
  } catch (err) {
    await sdk.logger.warn(`session notice failed: ${err?.message || err}`);
    return undefined;
  }
}

export function registerHooks(sdk, runtime) {
  sdk.hooks.onDecision("tools/pre-execute", () => {
    runtime.state.lastToolStartedAt = Date.now();
    return undefined;
  });
  sdk.hooks.onDecision("tools/post-execute", (invocation) => onToolResult(sdk, runtime, invocation));
  sdk.hooks.onDecision("agent/before-start", () => onBeforeStart(sdk, runtime));
}
