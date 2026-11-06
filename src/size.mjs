// 尺寸解析：把 (size | resolution + ratio) 归一成 { size, composition, note }。
// size 为空表示不下发像素尺寸，改由提示词里的构图描述约束。

import { SQUARE_SIZES, RATIO_HINTS, ANIMATED_DIRECTIVE } from "./config.mjs";

// 大小写不敏感：调用方不保证写小写 x，"2048X2048" 也是方形。
const isSquare = (value) => /^(\d+)x\1$/i.test(String(value ?? ""));

export function resolveSize({ size, resolution, ratio, animated = false } = {}) {
  // 动画 GIF：尺寸由上游自选（实测 291~437px），2K/4K 本地放大不适用于 GIF，
  // 强传像素没有意义。保留非方形的构图提示，其余像素档全部忽略。
  if (animated) {
    const wanted = String(ratio ?? "").trim();
    const composition = wanted && wanted !== "1:1" ? (RATIO_HINTS[wanted] ?? `${wanted} 构图`) : "";
    return {
      size: "",
      composition,
      note: "动画 GIF 由上游决定尺寸（实测约 300~440px，不走本地放大），size/resolution 已忽略。",
    };
  }

  // 显式像素优先。大小写归一，避免 "AUTO" 被当成真实尺寸下发。
  const explicit = String(size ?? "").trim();
  if (explicit && explicit.toLowerCase() !== "auto") {
    return {
      size: explicit,
      composition: "",
      note: isSquare(explicit)
        ? ""
        : `显式尺寸 ${explicit} 非方形：上游可能仍按方形出图再被服务端放大硬拉，画面会变形。要自然横竖版请改用 ratio。`,
    };
  }

  const level = String(resolution ?? "")
    .trim()
    .toLowerCase();
  const wanted = String(ratio ?? "").trim();
  const square = !wanted || wanted === "1:1";

  if (square) {
    if (!level) return { size: "", composition: "", note: "" };
    const target = SQUARE_SIZES[level];
    if (!target) {
      return { size: "", composition: "", note: `未知 resolution=${resolution}，已忽略。` };
    }
    return { size: target, composition: "", note: "" };
  }

  // 非方形：不下发像素，改把构图写进提示词。
  const composition = RATIO_HINTS[wanted] ?? `${wanted} 构图`;
  return {
    size: "",
    composition,
    note: level ? `非方形不传像素，${level} 只是提示，实际分辨率由上游决定。` : "",
  };
}

export function withComposition(prompt, composition) {
  return composition ? `${prompt}\n\n构图要求：${composition}。` : prompt;
}

export function withAnimated(prompt, animated) {
  return animated ? `${prompt}\n\n${ANIMATED_DIRECTIVE}` : prompt;
}
