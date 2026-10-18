// chatgpt2api 客户端：固定走 SSE 解析图片帧。
//
// 必须流式：上游先发 heartbeat 注释帧保活再出图。经 Cloudflare 免费版那种
// 源站 100 秒超时的反向代理时，非流式要等整张图生成完才回响应头，一超 100 秒必被掐成 524。

import { API_KEY, BASE_URL, MAX_RETRIES, RETRY_BASE_MS, TIMEOUT_MS } from "./config.mjs";

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

/** 网关类错误码，属瞬时过载，可重试。 */
const RETRYABLE = new Set([502, 503, 504, 524]);

/**
 * 服务端 deadline 判定。
 *
 * 503 有两种来源：网关瞬时过载，和服务端判定「这次生成超过截止线」。
 * 后者带 task_interrupted，同一份请求再发一次只会再撞同一条线：
 * 图生图单张 2 到 6 分钟，重试两次能把一次调用拖到 30 分钟以上，
 * 而 MCP 客户端通常 10 分钟就先超时了。这种 503 必须直接失败。
 */
const DEADLINE_MARK = /task_interrupted/i;

/**
 * 把上游错误响应压成一行可读原因。
 * 网关会返回整页 HTML，直接塞进返回会把表格撑爆，也没人看得懂。
 */
export function describeHttpError(status, body) {
  const text = String(body ?? "");

  // Cloudflare 的 5xx 页面里 <title> 就是人话原因。
  const title = text.match(/<title>([^<]{1,120})<\/title>/i)?.[1];
  if (title) return `HTTP ${status}：${title.replace(/\s+/g, " ").trim()}`;

  // 上游自己的 JSON 错误。
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message;
    if (message) return `HTTP ${status}：${String(message).slice(0, 160)}`;
  } catch {
    // 不是 JSON，继续按纯文本处理
  }

  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return plain ? `HTTP ${status}：${plain.slice(0, 160)}` : `HTTP ${status}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 调一次 chatgpt2api，网关类错误自动重试。
 * @param {object} payload 请求体，会自动补 stream:true
 * @param {string} path    /images/generations 或 /images/edits
 */
export async function callUpstream(payload, path) {
  if (!API_KEY) {
    throw new Error(
      "缺少 CHATGPT2API_API_KEY。请在 DSH 的 MCP 行里用自己的 env 块声明——DSH 会清洗 stdio 子进程的环境。",
    );
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * attempt);
    try {
      return await callOnce(payload, path);
    } catch (error) {
      lastError = error;
      if (!error?.retryable) throw error;
    }
  }

  throw new Error(
    `${lastError.message}（已重试 ${MAX_RETRIES} 次仍失败，多为上游瞬时过载，稍后再试或降低并发）`,
    {
      cause: lastError,
    },
  );
}

async function callOnce(payload, path) {
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
      const error = new Error(describeHttpError(response.status, body));
      error.status = response.status;
      error.retryable = RETRYABLE.has(response.status) && !DEADLINE_MARK.test(body);
      throw error;
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
