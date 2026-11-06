// 假的 chatgpt2api，用于离线集成测试。真实上游的 SSE 协议与响应格式照此模拟。
//
// 用 node:http 起一个本地服务，暴露 /v1/images/generations、/v1/images/edits、/v1/models。
// 不联网、不需要密钥、不消耗额度。

import { createServer } from "node:http";

/** 1x1 的合法 PNG，避免测试依赖外部素材。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * 构造合法的 GIF89a 字节流（N 帧，2x2 画布）。
 * 每帧一个 Graphic Control Extension（21 F9 04）+ 图像描述符，供帧数断言。
 */
function gifBytes(frames) {
  const parts = [
    Buffer.from("GIF89a", "latin1"),
    Buffer.from([0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]), // LSD 2x2 无调色板
  ];
  for (let index = 0; index < frames; index += 1) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x64, 0x00, 0x00])); // GCE，100ms/帧
    parts.push(Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00])); // 图像描述符
    parts.push(Buffer.from([0x02, 0x02, 0x04, 0x03])); // 最小 LCM 数据
    parts.push(Buffer.from([0x00]));
  }
  parts.push(Buffer.from([0x3b])); // trailer
  return Buffer.concat(parts);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 启动假上游。
 * @param {object} options
 * @param {number} options.delayMs 每个请求的模拟耗时，用来验证并发
 * @returns {Promise<{ url: string, close: () => Promise<void>, stats: object }>}
 */
export async function startMockUpstream({ delayMs = 0 } = {}) {
  const stats = { generations: 0, edits: 0, deadline503: 0, peakConcurrent: 0, active: 0, payloads: [] };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/v1/models" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-image-2.6" }] }));
      return;
    }

    const isGenerate = url.pathname === "/v1/images/generations";
    const isEdit = url.pathname === "/v1/images/edits";
    if (!isGenerate && !isEdit) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const body = JSON.parse((await readBody(request)) || "{}");

    stats.active += 1;
    stats.peakConcurrent = Math.max(stats.peakConcurrent, stats.active);
    if (isGenerate) stats.generations += 1;
    else stats.edits += 1;

    // 记录每个请求的实际参数，供测试断言「任务之间互不干扰」。
    stats.payloads.push({
      route: isGenerate ? "gen" : "edit",
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      model: body.model ?? "",
      n: body.n ?? 1,
      size: body.size ?? "",
      quality: body.quality ?? "",
      imageCount: Array.isArray(body.images) ? body.images.length : 0,
      imageHashes: Array.isArray(body.images) ? body.images.map((item) => String(item).slice(-24)) : [],
    });

    // 特殊约定：提示词里带 deadline-503 时，模拟服务端判定的截止超时。
    // 这种 503 重试没有意义，客户端必须只打一次就失败。
    if (typeof body.prompt === "string" && body.prompt.includes("deadline-503")) {
      stats.deadline503 += 1;
      stats.active -= 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "task_interrupted: 超过 image_request_timeout_secs" } }),
      );
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // 上游会先发注释帧保活，这里照样发，用来验证解析器把冒号帧忽略掉。
    response.write(": heartbeat\n\n");
    if (delayMs > 0) await sleep(delayMs);

    const count = Math.min(Math.max(Number(body.n) || 1, 1), 4);

    // 特殊约定：提示词里带 echo 时，把参考图原样回传，用于测试「上游回传原图」的告警。
    const wantsEcho = typeof body.prompt === "string" && body.prompt.includes("echo");

    // 特殊约定：提示词带 animated GIF（ANIMATED_DIRECTIVE 的固定内容）时回 8 帧 GIF 字节，
    // 模拟 Images 2.6 的动图产出，让集成测试能断言后缀、帧数与报告。
    const wantsGif = typeof body.prompt === "string" && body.prompt.includes("animated GIF");

    if (wantsEcho && isEdit && Array.isArray(body.images) && body.images.length > 0) {
      const reference = String(body.images[0]);
      const at = reference.indexOf("base64,");
      if (at >= 0) {
        response.write(frame({ created: 1, b64_json: reference.slice(at + 7) }));
      }
    } else {
      for (let index = 0; index < count; index += 1) {
        const image = wantsGif ? gifBytes(8) : PNG_1X1;
        response.write(frame({ created: 1, b64_json: image.toString("base64") }));
      }
    }

    response.write("data: [DONE]\n\n");
    response.end();
    stats.active -= 1;
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    stats,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
