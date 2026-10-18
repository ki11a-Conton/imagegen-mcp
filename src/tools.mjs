// 工具面：两个工具。
//   create_images  批量生图 / 改图（自动路由 + 自动并发）
//   list_models    模型档位、连通性、默认输出目录

import { z } from "zod";

import {
  BASE_URL,
  DEFAULT_CONCURRENCY,
  DEFAULT_MODEL,
  IMAGE_MODELS,
  IMAGE_SIZES,
  MAX_CONCURRENCY,
  MAX_JOBS,
  OUTPUT_ROOT,
  PKG_VERSION,
  RATIOS,
  RATIO_HINTS,
  RESOLUTIONS,
  TIMEOUT_MS,
} from "./config.mjs";
import { runJobs } from "./job.mjs";
import { formatReport } from "./report.mjs";
import { probeModels } from "./upstream.mjs";

const text = (value) => [{ type: "text", text: value }];

const qualityEnum = z.enum(["auto", "low", "medium", "high"]);

/** 单个生图组。job 级参数覆盖顶层默认值。 */
const jobSchema = z.object({
  prompt: z.string().min(1).describe("这一组要画什么，或要改成什么样。写清主体、风格、构图、光线。"),
  images: z
    .array(z.string())
    .max(16)
    .optional()
    .describe("参考图绝对路径，最多 16 张。给了就是图生图，不给就是文生图。多图时第一张通常是被改的主体。"),
  name: z
    .string()
    .optional()
    .describe("产物文件名，不含扩展名，例如 三视图。留空自动命名。重名自动加 -2/-3，不会覆盖已有文件。"),
  n: z.number().int().min(1).max(4).optional().describe("这一组出几张，默认 1，最多 4。"),
  ratio: z.enum(RATIOS).optional().describe("画面比例，默认 1:1。横竖版一律用它，不要用 size。"),
  resolution: z.enum(RESOLUTIONS).optional().describe("清晰度档位，只对方形真正生效。"),
  size: z.enum(IMAGE_SIZES).optional().describe("精确像素。只有用户点名像素时才用，非方形会被拉变形。"),
  quality: qualityEnum.optional().describe("质量档。上游实测无差异，一般不用传。"),
  model: z.enum(IMAGE_MODELS).optional().describe("图片模型。四个名字在上游是同一个 auto 路由。"),
  folder: z.string().optional().describe("在输出根目录下再开子目录，支持 a/b 多级，用于分类归档。"),
  output_dir: z.string().optional().describe("覆盖输出根目录的绝对路径。一般不传。"),
});

export function registerTools(server) {
  server.registerTool(
    "create_images",
    {
      title: "批量生图 / 改图",
      description:
        "一次调用跑多个生图任务，自动判断文生图还是图生图，并自动并发执行。\n" +
        "- 任务给 images 就是图生图（改图、换背景、换风格、风格迁移），不给就是文生图。\n" +
        "- 多个任务自动并发（默认 3 路），不需要派多个子 agent 分别调用。\n" +
        "- 图片默认落在项目 output/ 目录，用 folder 分类，用 name 直接指定文件名。\n" +
        "- 返回里已经带好可直接使用的 Markdown 图片引用：单张是一行，多张是每行两张的表格，复制进回复即可展示，不要再自己拼路径。\n" +
        "提示词写「要变成什么样」，需要保留的部分也一并说明。图生图单张 2 到 6 分钟属正常，慢不等于卡死。",
      inputSchema: {
        jobs: z
          .array(jobSchema)
          .min(1)
          .max(MAX_JOBS)
          .optional()
          .describe("任务数组，最多 " + MAX_JOBS + " 个，并发执行。只有一个任务时可用顶层 prompt 简写。"),
        prompt: z.string().optional().describe("单任务简写：要画什么。仅在 jobs 为空时生效。"),
        images: z
          .array(z.string())
          .max(16)
          .optional()
          .describe("单任务简写：参考图路径。仅在 jobs 为空时生效。"),
        name: z.string().optional().describe("单任务简写：产物文件名。"),
        n: z.number().int().min(1).max(4).optional().describe("所有任务的默认张数，默认 1，最多 4。"),
        folder: z.string().optional().describe("所有任务的默认子目录，任务级 folder 可覆盖。"),
        output_dir: z.string().optional().describe("所有任务的默认输出根目录，任务级 output_dir 可覆盖。"),
        ratio: z.enum(RATIOS).optional().describe("所有任务的默认比例。"),
        resolution: z.enum(RESOLUTIONS).optional().describe("所有任务的默认清晰度档位。"),
        size: z
          .enum(IMAGE_SIZES)
          .optional()
          .describe("所有任务的默认精确像素。非方形会被拉变形，优先用 ratio。"),
        quality: qualityEnum.optional().describe("所有任务的默认质量档。上游实测无差异，一般不用传。"),
        model: z
          .enum(IMAGE_MODELS)
          .optional()
          .describe("所有任务的默认模型，缺省 " + DEFAULT_MODEL + "。"),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONCURRENCY)
          .optional()
          .describe("并发路数，默认 " + DEFAULT_CONCURRENCY + "。上游对并发敏感，不建议超过 4。"),
      },
    },
    async (args) => {
      const defaults = {
        folder: args.folder,
        output_dir: args.output_dir,
        ratio: args.ratio,
        resolution: args.resolution,
        size: args.size,
        quality: args.quality,
        model: args.model,
        n: args.n,
      };

      const rawJobs =
        Array.isArray(args.jobs) && args.jobs.length > 0
          ? args.jobs
          : args.prompt
            ? [{ prompt: args.prompt, images: args.images, name: args.name }]
            : [];

      const batch = await runJobs(rawJobs, defaults, args.concurrency);
      return { content: text(formatReport(batch, { root: OUTPUT_ROOT })) };
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "查看可用模型与默认输出目录",
      description:
        "返回上游可用的图片模型、档位、比例选项、默认输出目录和连通性。\n" +
        "参数不确定、或者想确认上游是否在线时先看这个。",
      inputSchema: {},
    },
    async () => {
      const live = await probeModels();
      const payload = {
        version: PKG_VERSION,
        upstream: {
          baseUrl: BASE_URL,
          reachable: live !== null,
          models: live,
        },
        defaultModel: DEFAULT_MODEL,
        outputDir: OUTPUT_ROOT,
        models: IMAGE_MODELS,
        resolutions: RESOLUTIONS,
        ratios: RATIOS,
        ratioHints: RATIO_HINTS,
        exactSizes: IMAGE_SIZES,
        timeoutMs: TIMEOUT_MS,
        limits: {
          maxJobs: MAX_JOBS,
          defaultConcurrency: DEFAULT_CONCURRENCY,
          maxConcurrency: MAX_CONCURRENCY,
          maxReferenceImages: 16,
        },
      };
      return { content: text(JSON.stringify(payload, null, 2)) };
    },
  );
}
