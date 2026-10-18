// chatgpt2api 客户端：固定走 SSE 解析图片帧。
//
// 必须流式：上游先发 heartbeat 注释帧保活再出图。经 Cloudflare 免费版那种
// 源站 100 秒超时的反向代理时，非流式要等整张图生成完才回响应头，一超 100 秒必被掐成 524。

import { API_KEY, BASE_URL, TIMEOUT_MS } from "./config.mjs";

/**
 * 把一帧 SSE 解析成对象。
 * 帧格式：event: <type>\ndata: {...}\n\n，冒号开头的注释帧（: heartbeat）直接忽略。
 */
function parseFrame(frame) {
  let event = "message";
  const data = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }

  if (data.length === 0) return null;

  const raw = data.join("\n");
  if (raw === "[DONE]") return null;

  try {
    return { event, value: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/** 解析 SSE 流，收集所有带 b64_json 或 url 的帧。 */
async function readImageSse(response) {
  const items = [];
  let usage = null;
  let created = null;
  let failure = "";

  const accept = (frame) => {
    const parsed = parseFrame(frame);
    if (!parsed) return;

    const { event, value } = parsed;

    const errorMessage = (() => {
      if (event === "error" || value?.type === "error" || value?.error) {
        return String(value?.error?.message ?? value?.message ?? "");
      }
      if (typeof value?.type === "string" && value.type.endsWith(".failed")) {
        return String(value?.error?.message ?? value?.message ?? "");
      }
      return "";
    })();

    if (errorMessage) {
      failure = errorMessage.slice(0, 600);
      return;
    }

    if (value?.created) created = value.created;
    if (value?.usage) usage = value.usage;
    if (value?.b64_json || value?.url) items.push(value);
  };

  const decoder = new TextDecoder();
  let buffer = "";

  // 统一换行：有些代理或服务端会发 CRLF，按 \n\n 切帧会完全切不开。
  const normalize = (text) => text.replaceAll("\r\n", "\n");

  for await (const chunk of response.body) {
    buffer = normalize(buffer + decoder.decode(chunk, { stream: true }));

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      accept(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer = normalize(buffer + decoder.decode());
  if (buffer.trim()) accept(buffer);

  if (items.length === 0) {
    throw new Error(
      failure ? `上游流里没有图片数据：${failure}` : "上游流里没有图片数据（流被关闭但没有 completed 帧）",
    );
  }

  return { object: "list", created, data: items, usage };
}

/**
 * 调一次 chatgpt2api。
 * @param {object} payload 请求体，会自动补 stream:true
 * @param {string} path    /images/generations 或 /images/edits
 */
export async function callUpstream(payload, path) {
  if (!API_KEY) {
    throw new Error(
      "缺少 CHATGPT2API_API_KEY。请在 DSH 的 MCP 行里用自己的 env 块声明——DSH 会清洗 stdio 子进程的环境。",
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

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`chatgpt2api ${response.status}: ${body.slice(0, 400)}`);
    }

    // 前置代理把响应体缓冲成 JSON 时的兜底。
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("event-stream")) {
      const body = await response.text();
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(`上游返回非 JSON：${body.slice(0, 300)}`);
      }
    }

    return await readImageSse(response);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `上游超时（${Math.round(TIMEOUT_MS / 1000)}s）。图生图单张 2 到 6 分钟属正常，慢不等于卡死。`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 探测上游可用模型。不可达返回 null，不抛错。 */
export async function probeModels() {
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

    const payload = await response.json();
    return (payload?.data ?? []).map(({ id }) => id).filter(Boolean);
  } catch {
    return null;
  }
}
