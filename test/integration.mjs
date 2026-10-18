// 集成测试：真起 MCP server，走真实 stdio 协议，对假上游发请求。
// 覆盖批量任务、自动路由、并发、输出目录、命名、Markdown 排版、回传告警。
// 不联网、不需要密钥。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockUpstream } from "./mock-upstream.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, "..", "src", "index.mjs");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: String(error?.message ?? error) });
  }
}

/** 从工具返回里取纯文本。 */
const textOf = (result) => (result?.content ?? []).map(({ text }) => text).join("\n");

/** 起一个连到假上游的 MCP client。extraEnv 用于覆盖全局并发这类进程级配置。 */
async function connect(upstreamUrl, outputDir, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      CHATGPT2API_BASE_URL: upstreamUrl,
      CHATGPT2API_API_KEY: "test-key",
      IMAGEGEN_OUTPUT_DIR: outputDir,
      PATH: process.env.PATH ?? "",
      ...extraEnv,
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "selftest", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "imagegen-integration-"));
  const mock = await startMockUpstream({ delayMs: 250 });

  try {
    const client = await connect(mock.url, workspace);
    const reference = join(workspace, "reference.png");
    await writeFile(reference, PNG_1X1);

    await check("list_models 报告上游可达", async () => {
      const text = textOf(await client.callTool({ name: "list_models", arguments: {} }));
      const payload = JSON.parse(text);
      if (payload.upstream.reachable !== true) throw new Error("upstream 应可达");
      if (!Array.isArray(payload.upstream.models) || payload.upstream.models.length === 0) {
        throw new Error("应返回上游模型列表");
      }
      if (payload.limits.maxJobs !== 8) throw new Error("maxJobs 应为 8");
    });

    await check("单任务简写可用", async () => {
      const text = textOf(
        await client.callTool({
          name: "create_images",
          arguments: { prompt: "一只兔子", ratio: "1:1", folder: "single", name: "one" },
        }),
      );
      if (!text.includes("1/1 ok")) throw new Error("应成功 1 个任务: " + text);
      if (!text.includes("markdown:")) throw new Error("单张应输出 markdown 段");
    });

    await check("批量任务自动路由：无图走 gen，有图走 edit", async () => {
      const before = { ...mock.stats };
      const text = textOf(
        await client.callTool({
          name: "create_images",
          arguments: {
            folder: "batch",
            concurrency: 3,
            jobs: [
              { prompt: "白底三视图", name: "a" },
              { prompt: "四视图", name: "b" },
              { prompt: "换成雪山背景", images: [reference], name: "c" },
            ],
          },
        }),
      );
      if (!text.includes("3/3 ok")) throw new Error("应 3 个全成功: " + text);
      if (mock.stats.generations - before.generations !== 2) throw new Error("应有 2 次文生图");
      if (mock.stats.edits - before.edits !== 1) throw new Error("应有 1 次图生图");
      if (!text.includes("markdown (2 per row):")) throw new Error("多张应输出表格形式: " + text);
    });

    await check("并发确实并行执行", async () => {
      if (mock.stats.peakConcurrent < 2) {
        throw new Error("峰值并发应大于等于 2，实际 " + mock.stats.peakConcurrent);
      }
    });

    await check("folder 分类落到子目录", async () => {
      const batchDir = join(workspace, "batch");
      const entries = await readdir(batchDir);
      if (entries.length !== 3) throw new Error("batch 目录应有 3 个文件，实际 " + entries.length);
    });

    await check("name 指定文件名生效且不覆盖同名", async () => {
      const text = textOf(
        await client.callTool({
          name: "create_images",
          arguments: { prompt: "同名第二次", folder: "batch", name: "a" },
        }),
      );
      if (!text.includes("1/1 ok")) throw new Error("应成功: " + text);
      const entries = await readdir(join(workspace, "batch"));
      if (!entries.includes("a.png")) throw new Error("应保留 a.png");
      if (!entries.some((entry) => entry.startsWith("a-2"))) {
        throw new Error("撞名应生成 a-2，实际: " + entries.join(", "));
      }
    });

    await check("n 大于 1 时生成多张", async () => {
      const result = await client.callTool({
        name: "create_images",
        arguments: { prompt: "四张", folder: "multi", n: 4, ratio: "16:9" },
      });
      const text = textOf(result);
      if (!text.includes("1/1 ok")) throw new Error("应成功: " + text);
      const entries = await readdir(join(workspace, "multi"));
      if (entries.length !== 4) throw new Error("应有 4 个文件，实际 " + entries.length);
    });

    await check("上游回传原图时给出告警", async () => {
      const text = textOf(
        await client.callTool({
          name: "create_images",
          arguments: { jobs: [{ prompt: "echo 这组", images: [reference], folder: "echo" }] },
        }),
      );
      if (!/与参考图字节相同/.test(text)) throw new Error("应提示回传原图: " + text);
    });

    await check("单任务失败不影响整批", async () => {
      const result = await client.callTool({
        name: "create_images",
        arguments: {
          jobs: [
            { prompt: "正常任务", folder: "mixed" },
            { prompt: "坏参考图", images: [join(workspace, "missing.png")], folder: "mixed" },
          ],
          concurrency: 2,
        },
      });
      const text = textOf(result);
      if (!text.includes("1/2 ok")) throw new Error("应 1 成 1 败: " + text);
      if (!text.includes("FAIL")) throw new Error("应有 FAIL 行: " + text);
      if (!/读不到参考图/.test(text)) throw new Error("应给出可读错误: " + text);
    });

    await check("输出里带可直接使用的 Markdown 图片引用", async () => {
      const text = textOf(
        await client.callTool({
          name: "create_images",
          arguments: { prompt: "引用测试", folder: "md", name: "mdshot" },
        }),
      );
      if (!/!\[mdshot\.png\]\(<[^)]+mdshot\.png>\)/.test(text)) {
        throw new Error("应输出尖括号包裹的图片引用: " + text);
      }
    });

    await check("两种调用方式的并发度一致：1 次调用 2 组 等于 2 次调用各 1 组", async () => {
      // 场景 B：一个 agent 调一次，带两个任务。
      mock.stats.peakConcurrent = 0;
      const single = await client.callTool({
        name: "create_images",
        arguments: {
          concurrency: 3,
          jobs: [
            { prompt: "并发丙一", folder: "par-b" },
            { prompt: "并发丙二", folder: "par-b" },
          ],
        },
      });
      const peakSingle = mock.stats.peakConcurrent;
      if (!textOf(single).includes("2/2 ok")) throw new Error("单次调用应两组成活");

      // 场景 A：两个 agent 各自调一次，各带一个任务，同时发起。
      mock.stats.peakConcurrent = 0;
      const [first, second] = await Promise.all([
        client.callTool({
          name: "create_images",
          arguments: { jobs: [{ prompt: "并发甲", folder: "par-a" }] },
        }),
        client.callTool({
          name: "create_images",
          arguments: { jobs: [{ prompt: "并发乙", folder: "par-a" }] },
        }),
      ]);
      const peakSplit = mock.stats.peakConcurrent;
      if (!textOf(first).includes("1/1 ok") || !textOf(second).includes("1/1 ok")) {
        throw new Error("两次独立调用应各自成功");
      }

      // 两种方式都必须真的并发，且并发度一致。
      if (peakSingle < 2) throw new Error("单次调用带两组任务应并发，实际 peak=" + peakSingle);
      if (peakSplit < 2) throw new Error("两次独立调用应并发，实际 peak=" + peakSplit);

      const dirA = await readdir(join(workspace, "par-a"));
      const dirB = await readdir(join(workspace, "par-b"));
      if (dirA.length !== 2) throw new Error("场景 A 应落 2 个文件，实际 " + dirA.length);
      if (dirB.length !== 2) throw new Error("场景 B 应落 2 个文件，实际 " + dirB.length);
    });

    await check("全局并发闸门：多次调用不会突破在途上限", async () => {
      const capped = await connect(mock.url, join(workspace, "capped"), {
        IMAGEGEN_MAX_CONCURRENCY: "2",
      });
      try {
        mock.stats.peakConcurrent = 0;
        await Promise.all([
          capped.callTool({
            name: "create_images",
            arguments: {
              concurrency: 3,
              jobs: [1, 2, 3].map((i) => ({ prompt: "压一" + i, folder: "cap" })),
            },
          }),
          capped.callTool({
            name: "create_images",
            arguments: {
              concurrency: 3,
              jobs: [1, 2, 3].map((i) => ({ prompt: "压二" + i, folder: "cap" })),
            },
          }),
        ]);
        if (mock.stats.peakConcurrent > 2) {
          throw new Error("在途上限应被压在 2，实际 " + mock.stats.peakConcurrent);
        }
        const files = await readdir(join(workspace, "capped", "cap"));
        if (files.length !== 6) throw new Error("应落 6 个文件，实际 " + files.length);
      } finally {
        await capped.close();
      }
    });

    await check("落盘文件是真实 PNG 且尺寸可读", async () => {
      const entries = await readdir(join(workspace, "md"));
      const bytes = await readFile(join(workspace, "md", entries[0]));
      if (bytes[0] !== 0x89 || bytes.subarray(1, 4).toString("latin1") !== "PNG") {
        throw new Error("落盘文件应是 PNG");
      }
      const text = textOf(await client.callTool({ name: "list_models", arguments: {} }));
      if (!text.includes("outputDir")) throw new Error("list_models 应报告输出目录");
    });

    await client.close();
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.log(passed + " passed, " + failures.length + " failed");
    for (const item of failures) console.log("  FAIL  " + item.name + ": " + item.message);
    process.exit(1);
  }
  console.log(passed + " passed");
}

main().catch((error) => {
  console.log("integration crashed: " + (error?.stack ?? error));
  process.exit(1);
});
