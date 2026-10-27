/**
 * 文案渲染与模型识别。
 *
 * 模板只替换已知占位符，未知的 {xxx} 原样保留：用户写错名字时能立刻发现，
 * 而不是被悄悄吞成空字符串。
 */

export function fillTemplate(template, vars = {}) {
  if (typeof template !== "string") return "";
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return whole;
    const value = vars[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

/** 从 Pi SDK 的 handler 上下文里尽量取出当前模型标识，取不到返回 null */
export function readModelLabel(ctx) {
  if (!ctx || typeof ctx !== "object") return null;

  const candidates = [ctx.model, ctx.session?.model, ctx.agent?.model];
  for (const model of candidates) {
    if (!model) continue;
    if (typeof model === "string") return model;
    if (typeof model !== "object") continue;
    const parts = [model.provider, model.id, model.name, model.api, model.model, model.slug]
      .filter((v) => typeof v === "string" && v.trim());
    if (parts.length) return parts.join(" ");
  }
  return null;
}

export function modelMatches(label, patterns) {
  if (!label || !Array.isArray(patterns) || patterns.length === 0) return false;
  const haystack = label.toLowerCase();
  return patterns.some((pattern) => {
    const needle = String(pattern || "").trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

/**
 * 决定这次要不要加鼓励语。
 * 返回 { text, reason } 或 null。
 */
export function pickEncouragement(config, ctx) {
  const enc = config?.encouragement;
  if (!enc || enc.mode === "off") return null;

  const text = (enc.text && enc.text.trim()) || config?.texts?.encouragement || "";
  if (!text.trim()) return null;

  if (enc.mode === "always") return { text, reason: "always" };

  const label = readModelLabel(ctx);
  if (!label) return null;
  if (!modelMatches(label, enc.matchModels)) return null;
  return { text, reason: `model:${label}` };
}
