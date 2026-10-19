// 集中配置：环境变量、路径、常量。其他模块只读不改。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录（src 的上一级）。默认输出目录挂在它下面。 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PKG_VERSION = (() => {
  try {
    const raw = readFileSync(join(PROJECT_ROOT, "package.json"), "utf8");
    return String(JSON.parse(raw).version || "unknown");
  } catch {
    return "unknown";
  }
})();

export const BASE_URL = (process.env.CHATGPT2API_BASE_URL || "http://127.0.0.1:3000/v1").replace(/\/+$/, "");
export const API_KEY = process.env.CHATGPT2API_API_KEY || "";
export const DEFAULT_MODEL = process.env.IMAGEGEN_DEFAULT_MODEL || "gpt-image-2.5";

/**
 * 单次上游调用超时。图生图实测 2 到 6 分钟一张，别调小。
 * 环境变量写错时回落到默认值，否则 NaN 会让 AbortController 立刻触发。
 */
export const TIMEOUT_MS = (() => {
  const parsed = Number(process.env.IMAGEGEN_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
})();

/** 默认落盘根目录：项目根目录下的 output/。任务可用 output 指到别处。 */
export const OUTPUT_ROOT = resolve(process.env.IMAGEGEN_OUTPUT_DIR || join(PROJECT_ROOT, "output"));

/**
 * 网关类错误（502 / 503 / 504 / 524）的重试次数与退避基数。
 *
 * 524 是反向代理的源站超时，属瞬时过载，重试往往就好了；
 * 但图生图本身要 2 到 6 分钟，重试次数不能大，否则一次调用拖太久。
 */
export const MAX_RETRIES = (() => {
  const parsed = Number(process.env.IMAGEGEN_MAX_RETRIES);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 2;
})();
export const RETRY_BASE_MS = 5_000;

/** 一次工具调用里最多几个任务。 */
export const MAX_JOBS = 8;

/** 单次调用的默认并发数。 */
export const DEFAULT_CONCURRENCY = 3;
/** 单次调用的并发上限。 */
export const MAX_CONCURRENCY = 6;

/**
 * 整个 MCP 进程同时在途的上游请求上限。
 *
 * 单次调用各自的并发限制加起来会失控：两个 agent 各发 3 个任务就是 6 路。
 * 用进程级闸门把总量压住，这样「N 个 agent 各调 1 次」与「1 个 agent 调 1 次带 N 组任务」
 * 对上游的压力完全一致，两种用法可以互换。
 *
 * 实测（2026-10-18，真上游）：
 *   文生图 6 路 / 8 路 / 12 路 全部成功，墙钟 60 至 99 秒。
 *   图生图 8 路 全部成功，墙钟 76 至 97 秒。
 * 也就是说 12 路仍未触顶。默认取 4 是保守值，不是实测边界，可按机器与网络上调。
 */
export const MAX_GLOBAL_CONCURRENCY = (() => {
  const parsed = Number(process.env.IMAGEGEN_MAX_CONCURRENCY);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
})();

/** chatgpt2api 单张参考图硬上限 50MB，base64 后约 1/3 膨胀，这里按原始字节卡 30MB。 */
export const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;

/** 上游图片模型白名单。四个名字在上游都落到 auto 路由，属别名。 */
export const IMAGE_MODELS = ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];

/**
 * 尺寸只对方形真正生效。
 * 上游按自己的默认方形出图，非方形若强传像素会被服务端 Lanczos 硬拉变形，
 * 所以非方形改为把构图写进提示词，让上游自己出对应比例。
 */
export const IMAGE_SIZES = [
  "auto",
  // 方形：显式给也安全，上游本来就是这个形状。
  "1024x1024",
  "2048x2048",
  "3840x3840",
  // 非方形：上游多按方形出图再由服务端硬拉，实测会变形。
  // 保留它们只为「用户点名像素」这一种情况，正常横竖版应当用 ratio。
  "1024x1536",
  "1536x1024",
  "1024x1365",
  "1365x1024",
  "1088x1920",
  "1920x1088",
  "2560x1440",
  "1440x2560",
  "3840x2160",
  "2160x3840",
];

export const RESOLUTIONS = ["1k", "2k", "4k"];
export const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];

export const SQUARE_SIZES = { "1k": "1024x1024", "2k": "2048x2048", "4k": "3840x3840" };

export const RATIO_HINTS = {
  "16:9": "横向宽幅构图（16:9 全景）",
  "9:16": "竖向构图（9:16 竖屏）",
  "4:3": "横向构图（4:3）",
  "3:4": "竖向构图（3:4）",
  "3:2": "横向构图（3:2）",
  "2:3": "竖向构图（2:3）",
};

export const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
