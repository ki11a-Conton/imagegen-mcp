#!/usr/bin/env node
// imagegen-mcp：让 DSH 里的模型能真的生图。
//
// 背景：DSH 自身没有生图能力——它约 250 个官方包里没有任何生图工具，
// @deepseek-ai/dsh-llm-pi-ai 的适配器契约只有 stream()，
// 底层 pi-ai 虽实现了 openrouter-images，但 DSH 从未把它接进来。
// 所以模型在对话里只能说「我没有生图工具」。
//
// 这个 MCP server 把 chatgpt2api 的图片接口暴露成模型可调用的工具，
// 同时把图片落盘到工作区（DSH 的 present 工具和 markdown 渲染都需要本地文件）。
//
// 工具：
//   generate_image      文生图 → POST /v1/images/generations
//   edit_image          图生图（参考图 + 提示词）→ POST /v1/images/edits
//   list_image_models   列出模型/档位/接口
//
// 用法（stdio，由 DSH 拉起）：
//   node src/index.mjs
//
// 环境变量：
//   CHATGPT2API_BASE_URL   chatgpt2api 的 /v1 地址，默认 http://127.0.0.1:3000/v1
//   CHATGPT2API_API_KEY    调用密钥（user 或 admin 均可），必需
//   IMAGEGEN_OUTPUT_DIR    图片落盘目录，默认取 DSH 工作区，兜底 ./generated-images
//   IMAGEGEN_DEFAULT_MODEL 默认图片模型，默认 gpt-image-2.5
//   IMAGEGEN_TIMEOUT_MS    单次调用超时，默认 600000（10 分钟）。
//                          图生图实测 2~6 分钟一张，别调小。
//
// 传输：一律走 SSE（请求里固定带 stream: true）。chatgpt2api 的流式生图会立刻先发
// `: heartbeat` 注释帧，然后才出图，所以经过反向代理 —— 典型是 Cloudflare 免费版
// 那条 100 秒「源站响应超时」—— 也不会拿到 524；非流式要等整张图生成完才回响应头，
// 只要生成超过 100 秒就必然被代理掐断。本地直连两种都行，但统一走流式更稳。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = (process.env.CHATGPT2API_BASE_URL || "http://127.0.0.1:3000/v1").replace(/\/+$/, "");
const API_KEY = process.env.CHATGPT2API_API_KEY || "";
const DEFAULT_MODEL = process.env.IMAGEGEN_DEFAULT_MODEL || "gpt-image-2.5";

// 版本号从 package.json 读，别再手写第二份 —— 0.5.0 那会儿服务器自报的版本
// 和 package.json 就对不上，用户报 bug 时对不上号。
const PKG_VERSION = (() => {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return String(pkg.version || "unknown");
  } catch {
    return "unknown";
  }
})();
const TIMEOUT_MS = Number(process.env.IMAGEGEN_TIMEOUT_MS || 600000);

// 图片必须落在「会话工作区」里：DSH 的 present 工具和 markdown 图片渲染都只认
// 工作区内的路径。MCP 子进程的 cwd 是插件目录，不是工作区，所以优先读显式配置，
// 再退回 DSH_WORKSPACE，最后才是插件目录下的 generated-images。
const OUTPUT_ROOT = resolve(
  process.env.IMAGEGEN_OUTPUT_DIR || process.env.DSH_WORKSPACE || process.cwd()
);
const OUTPUT_DIR = resolve(OUTPUT_ROOT, "generated-images");

// 与 chatgpt2api 的图片模型白名单保持一致（utils/helper.py: WEB_IMAGE_MODELS）。
// 故意只暴露 gpt-image-* 系列：对话模型（gpt-6）不该出现在生图工具里。
const IMAGE_MODELS = [
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
];

// 尺寸档位对齐控制台的 IMAGE_SIZE_PRESETS（web-vue/src/api/imageTasks.ts）。
//
// 重要：尺寸是**通过提示词**传给上游的（conversation.build_image_prompt 写
// 「输出图片尺寸为 X」），上游并不严格遵守——实测请求 1024x1024 时上游按自己的
// 1254x1254 出图。2K/4K 之所以能达标，是因为 chatgpt2api 开了
// image_upscale_enabled 后会在本地做 Lanczos 放大（image_upscale_service.py）。
// 所以：>1K 的档位依赖服务端 image_upscale_enabled=true，且是「放大」不是重绘。
const IMAGE_SIZES = [
  "auto",
  // 1K 档
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1024x1365",
  "1365x1024",
  "1088x1920",
  "1920x1088",
  // 2K 档
  "2048x2048",
  "2560x1440",
  "1440x2560",
  // 4K 档
  "3840x2160",
  "2160x3840",
];

// 友好档位：调用方说「2K + 16:9」比记 2560x1440 直观得多。
const RESOLUTIONS = ["1k", "2k", "4k"];
const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];

// 方案 A（避免变形）：
//
// 上游不遵守尺寸提示——实测请求 1024x1024 得到 1254x1254，说明它按自己的默认
// 方形出图。而 chatgpt2api 的本地放大用 fit:'fill'（Sharp）/ 直接 resize（Pillow），
// 是**硬拉**不是裁剪：把方图拉到 16:9 会把正圆拉成 1.78:1 的椭圆（已实测）。
//
// 所以：
//   - 方形（1:1）：安全。上游本来就出方图，放大只是等比提升像素，不变形。
//   - 非方形：不传像素尺寸，改为把构图写进提示词，让上游自己按比例出图。
const RATIO_HINTS = {
  "16:9": "横向宽幅构图（16:9 全景）",
  "9:16": "竖向构图（9:16 竖屏）",
  "4:3": "横向构图（4:3）",
  "3:4": "竖向构图（3:4）",
  "3:2": "横向构图（3:2）",
  "2:3": "竖向构图（2:3）",
};

// 1:1 的像素档。只有方形才会真正下发 size——方形是安全的：上游本来就出方图，
// 本地放大是等比提升像素，不会变形。
// 注意 4K 方形用 3840x3840（"4K" 指长边 3840）：官方 13 档里没有方形 4K，
// 而 3840x2160 是 16:9，拿它当方形会立刻被拉变形。
const SQUARE_SIZES = { "1k": "1024x1024", "2k": "2048x2048", "4k": "3840x3840" };

const isSquareSize = (value) => /^(\d+)x\1$/.test(String(value || ""));

// 优先级：显式 size > resolution/ratio > 不传（上游按自己默认出图）。
// 返回 { size, composition, note }：size 为空表示不下发像素尺寸。
function resolveSize({ size, resolution, ratio }) {
  // 显式像素：调用方明确点名了这个尺寸，照传。非方形仍会拉伸，用 note 说明。
  if (size && size !== "auto") {
    return {
      size,
      composition: "",
      note: isSquareSize(size)
        ? ""
        : `注意：${size} 非方形，上游很可能仍按方形出图再被本地放大硬拉，画面会变形。` +
          "想要自然的横/竖版，请改用 ratio 或在提示词里描述构图。",
    };
  }

  const level = String(resolution || "").toLowerCase();
  const wanted = String(ratio || "");
  const square = !wanted || wanted === "1:1";

  if (square) {
    // 只想要方形：安全，按档位下发像素（本地等比放大）。
    if (!level) return { size: "", composition: "", note: "" };
    const target = SQUARE_SIZES[level];
    if (!target) return { size: "", composition: "", note: `未知 resolution=${resolution}，已忽略` };
    return { size: target, composition: "", note: "" };
  }

  // 非方形：不下发像素，改把构图写进提示词，交给上游决定实际分辨率。
  const composition = RATIO_HINTS[wanted] || `${wanted} 构图`;
  const asked = level ? `（你要求 ${level}）` : "";
  return {
    size: "",
    composition,
    note:
      `已避免拉伸：非方形不传像素尺寸，改为在提示词里要求「${composition}」，` +
      `实际分辨率由上游决定${asked}。若要强制精确像素，请显式传 size（但可能变形）。`,
  };
}

const text = (value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];

// 参考图（图生图）用的 MIME 表。上游只认图片，MIME 认错了会 400。
const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

// chatgpt2api 单张参考图的硬上限是 50MB（api/image_inputs.py: MAX_IMAGE_REFERENCE_BYTES）。
// base64 会把体积撑大约 1/3，所以这里按原始字节卡在 30MB：早点给出可读的报错，
// 而不是让服务端丢一个 400 回来。
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;

// 把调用方给的参考图统一成 chatgpt2api 能吃的形式（api/image_inputs.py: _sources_from_value）。
// 它认三种：data: URL、http(s) URL、裸 base64。这里把本地文件读成 data: URL，另外两种透传 ——
// 模型手里通常是工作区里的文件路径，所以读文件是主路径。
async function toImageReference(value) {
  const ref = String(value ?? "").trim();
  if (!ref) throw new Error("参考图为空：image / images 里有一项是空字符串");
  if (/^data:/i.test(ref) || /^https?:\/\//i.test(ref)) return ref;

  const filePath = resolve(ref);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(
      `读不到参考图：${ref} —— 它既不是 data:/http(s) URL，也不是存在的本地文件。` +
        "要用手上的图片请传绝对路径。"
    );
  }
  if (!info.isFile()) throw new Error(`参考图不是文件：${filePath}`);
  if (info.size === 0) throw new Error(`参考图是空文件：${filePath}`);
  if (info.size > MAX_REFERENCE_BYTES) {
    throw new Error(
      `参考图 ${(info.size / 1024 / 1024).toFixed(1)} MB 超过 30MB 上限：${filePath}。` +
        "请先压缩或缩小；chatgpt2api 单张参考图硬上限 50MB（base64 后还要再膨胀约 1/3）。"
    );
  }
  const mime = IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()] || "image/png";
  const data = await readFile(filePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

function extFromMime(mime) {
  const clean = String(mime || "").split(";")[0].trim().toLowerCase();
  if (clean === "image/jpeg" || clean === "image/jpg") return ".jpg";
  if (clean === "image/webp") return ".webp";
  if (clean === "image/gif") return ".gif";
  return ".png";
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// 从字节判断真实图片格式。b64_json 分支原来把后缀硬编码成 .png，
// 而 response_format=b64_json 并不保证返回 PNG —— 上游哪天回 JPEG，
// 就会得到一个后缀 .png、内容其实是 JPEG 的文件（放宽校验的工具会报错）。
function extFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return ".webp";
  if (buffer.toString("latin1", 0, 3) === "GIF") return ".gif";
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return ".bmp";
  return "";
}

// output_dir 有可能已经被指到 ...\generated-images（很自然，因为想直接放那儿），
// 这时不能再套一层，否则会得到 generated-images/generated-images/。
function resolveTargetDir(outputDir) {
  const base = outputDir ? resolve(outputDir) : OUTPUT_ROOT;
  return basename(base).toLowerCase() === "generated-images" ? base : resolve(base, "generated-images");
}

// 并发调用时不能撞名：timestamp() 只精确到秒，两次调用落在同一秒就会生成同一个
// 文件名，而 writeFile 默认是覆盖模式，后一张会把前一张静默盖掉（图永久丢失、
// 全程没有报错）。所以文件名再拼 8 位随机量，并且用 flag "wx" 独占创建 ——
// 真撞上了会抛 EEXIST 让我们重试，而不是静默丢数据。
async function writeNewFile(targetDir, baseName, ext, buffer) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const target = join(targetDir, `${baseName}-${randomUUID().slice(0, 8)}${ext}`);
    try {
      await writeFile(target, buffer, { flag: "wx" });
      return target;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // 极小概率：随机量也撞上了，换一个再试
    }
  }
  throw new Error(`无法在 ${targetDir} 生成不冲突的文件名（连续 5 次 EEXIST）`);
}

// 解析生图的 SSE 流，把每一帧 image_*.completed 收集成 data[]。
// 帧格式：`event: <type>\n data: {"type":..., "b64_json":...}\n\n`，
// 另有以冒号开头的注释帧（`: heartbeat`），是为反向代理保活的，直接忽略。
async function readImageSse(response) {
  const items = [];
  let usage = null;
  let created = null;
  let failure = "";

  const handleFrame = (frame) => {
    let event = "message";
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      // 其余（含 ':' 开头的注释）忽略
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    if (raw === "[DONE]") return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (event === "error" || obj?.type === "error" || obj?.error) {
      failure = String(obj?.error?.message || obj?.message || raw).slice(0, 600);
      return;
    }
    if (typeof obj?.type === "string" && obj.type.endsWith(".failed")) {
      failure = String(obj?.error?.message || obj?.message || raw).slice(0, 600);
      return;
    }
    if (obj?.created) created = obj.created;
    if (obj?.usage) usage = obj.usage;
    if (obj && (obj.b64_json || obj.url)) items.push(obj);
  };

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      handleFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleFrame(buffer);

  if (items.length === 0) {
    throw new Error(
      `chatgpt2api 的流式响应里没有图片数据${failure ? `：${failure}` : "（流被关闭但没有 completed 帧）"}`
    );
  }
  return { object: "list", created, data: items, usage };
}

async function callChatgpt2api(payload, path = "/images/generations") {
  if (!API_KEY) {
    throw new Error(
      "CHATGPT2API_API_KEY is not set — the MCP row must declare it in its own env: block " +
        "(DSH scrubs ambient env for stdio children)"
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
    });
    const contentType = String(response.headers.get("content-type") || "");
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw new Error(`chatgpt2api ${response.status}: ${raw.slice(0, 600)}`);
    }
    // 服务端没按流式回（例如前置了别的代理把 body 缓冲成 JSON）时兜底。
    if (!contentType.includes("event-stream")) {
      const raw = await response.text();
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`chatgpt2api returned non-JSON: ${raw.slice(0, 300)}`);
      }
    }
    return await readImageSse(response);
  } finally {
    clearTimeout(timer);
  }
}

// chatgpt2api 在 response_format=b64_json 时返回 base64；在 url 模式下返回它自己的
// 图片链接（http://127.0.0.1:3000/images/...）。两种都要能落盘成工作区里的真实文件。
async function saveImage(item, index, targetDir, prefix = "image") {
  const b64 = String(item?.b64_json || "").trim();
  if (b64) {
    const buffer = Buffer.from(b64, "base64");
    const ext = extFromBuffer(buffer) || ".png";
    const target = await writeNewFile(targetDir, `${prefix}-${timestamp()}-${index + 1}`, ext, buffer);
    return { path: target, bytes: buffer.length, sha256: sha256Of(buffer) };
  }

  const url = String(item?.url || "").trim();
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download generated image ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mime = response.headers.get("content-type") || "";
  const ext = extFromBuffer(buffer) || extname(new URL(url).pathname) || extFromMime(mime);
  const target = await writeNewFile(targetDir, `${prefix}-${timestamp()}-${index + 1}`, ext, buffer);
  return { path: target, bytes: buffer.length, sourceUrl: url, sha256: sha256Of(buffer) };
}

// 把 chatgpt2api 的返回落盘。文生图和图生图共用这段。
async function saveResultItems(result, targetDir, prefix = "image") {
  const items = Array.isArray(result?.data) ? result.data : [];
  if (items.length === 0) {
    throw new Error(`chatgpt2api 没有返回图片数据：${JSON.stringify(result).slice(0, 400)}`);
  }
  const saved = [];
  for (let index = 0; index < items.length; index += 1) {
    const file = await saveImage(items[index], index, targetDir, prefix);
    if (file) saved.push(file);
  }
  if (saved.length === 0) {
    throw new Error("chatgpt2api 返回了图片条目，但没有任何一项带 b64_json 或 url");
  }
  return { saved, items };
}

function buildReport({ title, saved, items, model, size, composition, note }) {
  const header = [title, `模型：${model}`, `尺寸：${size || "auto（由上游按构图要求决定）"}`];
  if (composition) header.push(`构图：${composition}（已写进提示词）`);
  if (note) header.push(`提示：${note}`);
  return [
    ...header,
    "",
    ...saved.map(
      (file, index) =>
        `${index + 1}. ${file.path} (${(file.bytes / 1024).toFixed(1)} KB)` +
        (items[index]?.revised_prompt ? `\n   上游改写后的提示词：${items[index].revised_prompt}` : "")
    ),
    "",
    "在回复里用 Markdown 图片语法引用这些绝对路径即可展示。",
  ].join("\n");
}

function createMcpServer() {
  const server = new McpServer(
    { name: "imagegen-mcp", version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "generate_image",
    {
      title: "生成图片",
      description:
        "用 ChatGPT 网页账号生成图片并保存到工作区。当用户要求画图、生成插画/海报/封面、或需要任何图片素材时调用。" +
        "务必传 output_dir=当前会话工作区的绝对路径，图片才会落在工作区内（否则 present 和 markdown 渲染拿不到）。" +
        "返回落盘后的绝对路径，可直接在回复里用 Markdown 图片语法引用。" +
        "【务必尊重用户明确提出的要求】用户说了尺寸/清晰度/张数/比例时，必须把这些参数传进来，不要自作主张用默认值。" +
        "用户说「2K」就传 resolution=2k，「16:9」就传 ratio=16:9，「竖版」用 ratio=9:16，「三张」传 n=3。" +
        "【比例怎么传】方形用 ratio=1:1；横版/竖版一律用 ratio（不要自己换算成像素去传 size），" +
        "工具会把构图要求写进提示词、让上游自己按比例出图——这是为了避免上游出方图后被本地放大硬拉变形。" +
        "模型名必须用 gpt-image-* 系列，不要传对话模型（如 gpt-6），否则会被拒绝。",
      inputSchema: {
        prompt: z.string().min(1).describe("图片描述，越具体越好（主体、风格、构图、光线、色彩）"),
        model: z
          .enum(IMAGE_MODELS)
          .optional()
          .describe(
            `图片模型，默认 ${DEFAULT_MODEL}。**四个名字现在在上游全部走同一个 auto 路由**` +
              "（2026-10 起 gpt-image-2 原本那条 gpt-5-3 上游 slug 已下线，chatgpt2api 已改为回退 auto），" +
              "实测同尺寸出图分辨率与耗时基本一致，属别名而非不同模型。用户没点名就别传。"
          ),
        resolution: z
          .enum(RESOLUTIONS)
          .optional()
          .describe(
            "清晰度档位：1k / 2k / 4k。**只对方形（ratio=1:1 或不传 ratio）真正生效**，此时按档位下发像素" +
              "（1k→1024x1024，2k→2048x2048，4k→3840x3840）并做本地等比放大。" +
              "非方形时该值只是提示，实际分辨率由上游决定。需要服务端开启 image_upscale_enabled。"
          ),
        ratio: z
          .enum(RATIOS)
          .optional()
          .describe(
            "画面比例：1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3，默认 1:1。" +
              "方形走本地放大；非方形会改为在提示词里要求对应构图，由上游出图，避免拉伸变形。"
          ),
        size: z
          .enum(IMAGE_SIZES)
          .optional()
          .describe(
            "精确像素尺寸，优先级最高。**只有用户明确点名像素（如「2560x1440」）时才传**。" +
              "非方形尺寸会被上游当方图出、再被本地放大硬拉，画面会变形（工具会在返回里警告）。" +
              "想要自然的横/竖版请改用 ratio。13 档：" +
              "1K: 1024x1024 / 1024x1536 / 1536x1024 / 1024x1365 / 1365x1024 / 1088x1920 / 1920x1088；" +
              "2K: 2048x2048 / 2560x1440 / 1440x2560；4K: 3840x2160 / 2160x3840。"
          ),
        quality: z
          .enum(["auto", "low", "medium", "high"])
          .optional()
          .describe(
            "质量，默认 auto。注意：该值只被拼进提示词文本，上游请求体里没有对应字段，实测不同档位出图分辨率一致，" +
              "基本不产生可观察差异——用户没要求就别传。"
          ),
        n: z.number().min(1).max(4).optional().describe("生成张数，默认 1，最多 4"),
        output_dir: z
          .string()
          .optional()
          .describe(
            "图片落盘目录。务必传当前会话工作区的绝对路径（例如 D:\\\\Download games\\\\chatgpt2api），" +
              "图片会写到 <output_dir>/generated-images/ 下；若 output_dir 本身就以 generated-images 结尾，则直接写进去，不会重复套一层。" +
              "不传则用 IMAGEGEN_OUTPUT_DIR 配置值。"
          ),
      },
    },
    async (args) => {
      const count = args.n || 1;
      // DSH 会清洗 stdio 子进程的环境（DSH_* 全丢），子进程拿不到工作区，
      // 所以优先用调用方显式传入的目录，保证图片落在会话工作区内。
      const targetDir = resolveTargetDir(args.output_dir);
      await mkdir(targetDir, { recursive: true });

      const resolved = resolveSize({
        size: args.size,
        resolution: args.resolution,
        ratio: args.ratio,
      });
      const usedModel = args.model || DEFAULT_MODEL;

      // 非方形不传像素尺寸，改为把构图要求写进提示词，让上游自己按比例出图。
      // 这样避免 chatgpt2api 的本地放大把方图硬拉成目标比例。
      const finalPrompt = resolved.composition
        ? `${args.prompt}\n\n构图要求：${resolved.composition}。`
        : args.prompt;

      const payload = {
        model: usedModel,
        prompt: finalPrompt,
        n: count,
        response_format: "b64_json",
      };
      if (resolved.size) payload.size = resolved.size;
      if (args.quality && args.quality !== "auto") payload.quality = args.quality;

      const result = await callChatgpt2api(payload);
      const { saved, items } = await saveResultItems(result, targetDir);
      return {
        content: text(
          buildReport({
            title: `已生成 ${saved.length} 张图片：`,
            saved,
            items,
            model: usedModel,
            size: resolved.size,
            composition: resolved.composition,
            note: resolved.note,
          })
        ),
      };
    }
  );

  server.registerTool(
    "edit_image",
    {
      title: "图生图（拿参考图按提示词生成新图）",
      description:
        "以用户给的图片为参考，按提示词生成新图：改图 / 换背景 / 换风格 / 局部修改 / 风格迁移都走这个工具。" +
        "当用户说「在我这张图上…」「把这张图改成…」「参考这张图生成…」「给这张图加/去掉…」时调用它。" +
        "【用户没给图片就不要调它】——凭空画图属于 generate_image。" +
        "【image】传图片在工作区里的绝对路径；也接受 http(s) URL 或 data: URL。" +
        "【多图参考】images 可传多张（最多 16），例如「把 B 的画风套到 A 上」；第一张通常是被改的主体。" +
        "【务必尊重用户明确提出的要求】用户说了尺寸/清晰度/张数/比例时，必须把这些参数传进来，不要自作主张用默认值。" +
        "【提示词怎么写】描述「要改成什么样」，并且把要保留的部分也写清楚（如「保持人物和构图不变，只把背景换成雪山日落」），" +
        "不要写成「这是一张什么图」的看图说话。" +
        "【耗时】图生图比文生图慢得多：要上传参考图 + 重新握手 + 生成 + 回传，实测单张 2~6 分钟；" +
        "偶尔上游回传图片时会卡住并最终 504（本次调用会失败）。慢不等于卡死，不要因此重复调用。",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("改图指令：要改成什么样，以及哪些部分要原样保留"),
        image: z
          .string()
          .optional()
          .describe("参考图路径（绝对路径最优，也接受 http(s) / data: URL）。与 images 至少给一个"),
        images: z
          .array(z.string())
          .min(1)
          .max(16)
          .optional()
          .describe("多张参考图的路径数组（最多 16 张）。与 image 至少给一个"),
        model: z
          .enum(IMAGE_MODELS)
          .optional()
          .describe(`图片模型，默认 ${DEFAULT_MODEL}。四个名字现在在上游走同一个 auto 路由，用户没点名就别传。`),
        resolution: z
          .enum(RESOLUTIONS)
          .optional()
          .describe("清晰度档位 1k/2k/4k，只对方形真正生效；非方形时仅作提示。需要服务端 image_upscale_enabled。"),
        ratio: z.enum(RATIOS).optional().describe("画面比例，默认 1:1。非方形会改为在提示词里要求对应构图，避免拉伸。"),
        size: z
          .enum(IMAGE_SIZES)
          .optional()
          .describe("精确像素尺寸，只有用户明确点名像素时才传；非方形传像素会被拉伸。"),
        quality: z
          .enum(["auto", "low", "medium", "high"])
          .optional()
          .describe("质量，默认 auto。只写进提示词，上游实测无差异，用户没要求就别传。"),
        n: z.number().min(1).max(4).optional().describe("生成张数，默认 1，最多 4"),
        output_dir: z
          .string()
          .optional()
          .describe(
            "图片落盘目录。务必传当前会话工作区的绝对路径，图片会写到 <output_dir>/generated-images/ 下；" +
              "若 output_dir 本身就以 generated-images 结尾，则直接写进去，不会重复套一层。" +
              "不传则用 IMAGEGEN_OUTPUT_DIR 配置值。"
          ),
      },
    },
    async (args) => {
      const refs = [];
      if (args.image) refs.push(args.image);
      if (Array.isArray(args.images)) refs.push(...args.images);
      if (refs.length === 0) {
        throw new Error(
          "图生图必须给参考图：请传 image（单张路径）或 images（路径数组）。" +
            "如果本来就是要凭空画一张，请改用 generate_image。"
        );
      }

      const count = args.n || 1;
      const targetDir = resolveTargetDir(args.output_dir);
      await mkdir(targetDir, { recursive: true });

      const resolved = resolveSize({
        size: args.size,
        resolution: args.resolution,
        ratio: args.ratio,
      });
      const usedModel = args.model || DEFAULT_MODEL;
      const finalPrompt = resolved.composition
        ? `${args.prompt}\n\n构图要求：${resolved.composition}。`
        : args.prompt;

      // 本地文件读成 data: URL 再走 JSON —— chatgpt2api 的 /v1/images/edits
      // 同时支持 multipart 和 JSON（api/image_inputs.py: parse_image_edit_request），
      // JSON 这条路不用手搓 boundary，交给 Node 的 fetch 更稳。
      const encoded = [];
      for (const ref of refs) encoded.push(await toImageReference(ref));

      const payload = {
        model: usedModel,
        prompt: finalPrompt,
        images: encoded,
        n: count,
        response_format: "b64_json",
      };
      if (resolved.size) payload.size = resolved.size;
      if (args.quality && args.quality !== "auto") payload.quality = args.quality;

      const result = await callChatgpt2api(payload, "/images/edits");
      // 落盘文件名用 edited- 前缀，方便和文生图的 image- 区分开。
      const { saved, items } = await saveResultItems(result, targetDir, "edited");

      // 上游偶尔会把参考图原样当结果回传。按字节比对，命中就明确提示丢弃，
      // 免得调用方把它当成"改好了"再交付出去。
      const referenceHashes = new Set(
        encoded
          .map((ref) => {
            const at = typeof ref === "string" ? ref.indexOf("base64,") : -1;
            return at < 0 ? "" : sha256Of(Buffer.from(ref.slice(at + 7), "base64"));
          })
          .filter(Boolean)
      );
      const echoed = saved.filter((file) => file.sha256 && referenceHashes.has(file.sha256)).length;

      return {
        content: text(
          buildReport({
            title: `已按参考图生成 ${saved.length} 张图片：`,
            saved,
            items,
            model: usedModel,
            size: resolved.size,
            composition: resolved.composition,
            note: [
              resolved.note,
              `参考图 ${encoded.length} 张`,
              echoed > 0
                ? `警告：其中 ${echoed} 张与参考图字节完全相同（上游把原图回传了，提示词没生效），建议丢弃后重试`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          })
        ),
      };
    }
  );

  server.registerTool(
    "list_image_models",
    {
      title: "列出可用图片模型与档位",
      description:
        "返回 chatgpt2api 当前可用的图片模型、清晰度档位、比例选项、本次实际使用的默认模型和落盘目录。" +
        "不确定参数怎么传时先调这个。",
      inputSchema: {},
    },
    async () => {
      let live = [];
      try {
        const response = await fetch(`${BASE_URL}/models`, {
          headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
        });
        if (response.ok) {
          const payload = await response.json();
          live = (payload?.data || []).map((item) => item?.id).filter(Boolean);
        }
      } catch {
        // 上游不可达时退回静态白名单，工具本身仍可用
      }
      return {
        content: text({
          baseUrl: BASE_URL,
          endpoints: {
            generate: "POST /images/generations —— 文生图（generate_image）",
            edit: "POST /images/edits —— 图生图（edit_image），参考图可传本地路径 / http(s) / data: URL",
          },
          version: PKG_VERSION,
          defaultModel: DEFAULT_MODEL,
          outputDir: OUTPUT_DIR,
          outputDirRule:
            "output_dir 传会话工作区根目录即可（图片写到 <output_dir>/generated-images/）；" +
            "如果传的目录本身就以 generated-images 结尾，则直接写进去，不会重复套层。",
          imageModels: IMAGE_MODELS,
          catalogModels: live,
          resolutions: RESOLUTIONS,
          ratios: RATIOS,
          squareSizes: SQUARE_SIZES,
          ratioHints: RATIO_HINTS,
          exactSizes: IMAGE_SIZES,
          behavior: {
            transport:
              "固定走 SSE（请求体带 stream:true）。服务端会先发 `: heartbeat` 注释帧保活再出图，" +
              "所以即使前置了 Cloudflare 这类 100 秒源站超时的反向代理也不会 524；" +
              "非流式要等整张图生成完才回响应头，超过 100 秒必被代理掐断。",
            concurrency:
              "并发安全：文件名 = 前缀-时间戳-序号-8位随机量，并且用 wx 独占创建（同名就报错重试），" +
              "所以多个调用同时往同一个目录写也不会互相覆盖（旧版同秒并发会静默丢图）。",
            square:
              "ratio=1:1 或不传 ratio：按 resolution 下发像素（1k→1024x1024，2k→2048x2048，4k→3840x3840），" +
              "本地等比放大，不变形。",
            nonSquare:
              "非方形：不下发像素尺寸，改为把构图要求写进提示词，由上游决定实际分辨率。" +
              "这是为了避免上游出方图后被本地放大硬拉变形。",
            explicitSize:
              "显式传 size：照传像素。非方形会被上游当方图出、再被本地放大硬拉，画面会变形（返回里会警告）。",
            edit:
              "图生图：参考图由本工具读成 data: URL 后走 JSON 提交（chatgpt2api 同时支持 multipart，JSON 这条路更省事）。" +
              "实测比文生图慢很多——上传参考图 + 重新握手 + 生成 + 回传，单张 2~6 分钟；" +
              "偶尔上游回传图片时会卡住并最终 504（调用失败，不是协议问题）。",
          },
          notes: [
            "model 四个名字在上游全部映射到 auto（2026-10 起 gpt-image-2 的 gpt-5-3 slug 已下线，改用 auto）；-flare / -sunburst 只是别名。",
            "quality 只写进提示词，上游不遵守，实测无差异。",
            "2K/4K 依赖服务端 image_upscale_enabled=true；上游不遵守尺寸提示，实际靠本地放大达成。",
            "上游实测对 1024x1024 请求返回 1254x1254（它按自己默认的方形出图），所以非方形强传像素必然变形。",
            "落盘文件名带 8 位随机量且用 wx 独占创建：并发调用、甚至同一秒完成，也不会互相覆盖。",
            "图生图会按 sha256 把输出与参考图逐字节比对；返回里若出现「与参考图完全相同」的警告，说明上游把原图回传了，那张要丢弃重试。",
          ],
        }),
      };
    }
  );

  return server;
}

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 上只能有协议数据：所有日志走 stderr，否则会污染 JSON-RPC 流。
  process.stderr.write(`imagegen-mcp ${PKG_VERSION} ready (base=${BASE_URL}, output=${OUTPUT_DIR})\n`);
}

main().catch((error) => {
  process.stderr.write(`imagegen-mcp fatal: ${error?.stack || error}\n`);
  process.exit(1);
});

// 供离线测试直接 import（并发落盘行为等）。MCP 正常运行时用不到这些导出。
export { writeNewFile, resolveTargetDir, extFromBuffer, sha256Of };
