// 工具面：两个工具，分工单一。
//   create_images   执行：批量生图 / 改图
//   imagegen_info   查询：用法速查 + 当前配置
//
// 描述只写「什么时候用、最容易踩的一条」，具体技巧放 imagegen_info 的输出。
// 描述写太长会被略读，技巧塞在这里等于没写。

import { z } from "zod";

import {
  BASE_URL,
  DEFAULT_CONCURRENCY,
  DEFAULT_MODEL,
  IMAGE_MODELS,
  IMAGE_SIZES,
  MAX_CONCURRENCY,
  MAX_JOBS,
  MAX_REFERENCE_BYTES,
  OUTPUT_ROOT,
  PKG_VERSION,
  RATIOS,
  RESOLUTIONS,
  TIMEOUT_MS,
} from "./config.mjs";
import { runJobs } from "./job.mjs";
import { formatReport } from "./report.mjs";
import { probeModels } from "./upstream.mjs";

const text = (value) => [{ type: "text", text: value }];

const qualityEnum = z.enum(["auto", "low", "medium", "high"]);

/** 单个生图组。任务级字段覆盖顶层默认值。 */
const jobSchema = z.object({
  prompt: z.string().min(1).describe("这一组画什么，或改成什么样。写主体、风格、构图、光线。"),
  images: z
    .array(z.string())
    .max(16)
    .optional()
    .describe("参考图路径，最多 16 张。给了走图生图，不给走文生图。多图时第一张是被改的主体。"),
  name: z.string().optional().describe("产物文件名，不含扩展名。重名自动加 -2，不会覆盖。"),
  n: z.number().int().min(1).max(4).optional().describe("这一组出几张，默认 1。"),
  ratio: z.enum(RATIOS).optional().describe("画面比例，默认 1:1。横竖版用它，不要用 size。"),
  resolution: z.enum(RESOLUTIONS).optional().describe("清晰度档，只对方形生效。"),
  size: z.enum(IMAGE_SIZES).optional().describe("精确像素。只有用户点名像素时用，非方形会变形。"),
  quality: qualityEnum.optional().describe("质量档。上游无差异，一般不用传。"),
  model: z.enum(IMAGE_MODELS).optional().describe("图片模型。四个名字在上游同一个 auto 路由。"),
  folder: z.string().optional().describe("输出根目录下的子目录，支持 a/b 多级。"),
  output_dir: z.string().optional().describe("覆盖输出根目录。一般不传。"),
});

/** 用法速查。放在查询工具的输出里，而不是塞进工具描述。 */
const USAGE = [
  "批量        jobs: [{prompt}, {prompt}]  一次调用跑多组，自动并发",
  "文生图      job 不带 images",
  "图生图      job 带 images，最多 16 张，第一张是被改的主体",
  "换位置      output_dir: 任意绝对路径，直接落在那儿，不会再套子目录",
  '分类归档    folder: "rabbit/refs"       相对输出根，不要写绝对路径',
  '固定文件名  name: "三视图"              重名自动加 -2，不会覆盖',
  '横竖版      ratio: "16:9" 或 "9:16"     不要用 size，会变形',
  "同题多张    n: 2 到 4",
  '清晰度      resolution: "2k"            只对方形生效',
  "只要一张    单任务可用顶层 prompt 简写，不必写 jobs",
  "展示        返回里的 markdown 块可直接粘贴；单张一行，并排与否自定",
];

export function registerTools(server) {
  server.registerTool(
    "create_images",
    {
      title: "批量生图 / 改图",
      description:
        "生成或修改图片。任务带 images 走图生图，不带走文生图，多任务自动并发。\n" +
        "返回可直接粘贴的 Markdown 图片引用。参数不确定先调 imagegen_info。",
      inputSchema: {
        jobs: z
          .array(jobSchema)
          .min(1)
          .max(MAX_JOBS)
          .optional()
          .describe("任务数组，最多 " + MAX_JOBS + " 个。只有一个任务时改用顶层 prompt 简写。"),
        prompt: z.string().optional().describe("单任务简写：画什么。仅在 jobs 为空时生效。"),
        images: z.array(z.string()).max(16).optional().describe("单任务简写：参考图路径。"),
        name: z.string().optional().describe("单任务简写：产物文件名。"),
        n: z.number().int().min(1).max(4).optional().describe("所有任务的默认张数。"),
        folder: z.string().optional().describe("所有任务的默认子目录。"),
        output_dir: z.string().optional().describe("所有任务的默认输出根目录。"),
        ratio: z.enum(RATIOS).optional().describe("所有任务的默认比例。"),
        resolution: z.enum(RESOLUTIONS).optional().describe("所有任务的默认清晰度档。"),
        size: z.enum(IMAGE_SIZES).optional().describe("所有任务的默认精确像素。"),
        quality: qualityEnum.optional().describe("所有任务的默认质量档。"),
        model: z.enum(IMAGE_MODELS).optional().describe("所有任务的默认模型。"),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONCURRENCY)
          .optional()
          .describe("并发路数，默认 " + DEFAULT_CONCURRENCY + "。"),
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
    "imagegen_info",
    {
      title: "查用法与当前配置",
      description:
        "返回用法速查、上游连通性、可用模型与默认输出目录。\n" +
        "不确定参数怎么传、想确认上游是否在线、想知道图片落在哪，先调这个。",
      inputSchema: {},
    },
    async () => {
      const live = await probeModels();
      const reachable = live !== null;

      const lines = [
        "imagegen-mcp " + PKG_VERSION,
        "upstream  " + (reachable ? "ok" : "不可达") + "  " + BASE_URL,
      ];

      if (reachable && Array.isArray(live) && live.length > 0) {
        lines.push("models    " + live.join("  "));
      }

      lines.push(
        "default   model=" + DEFAULT_MODEL + "  output=" + OUTPUT_ROOT,
        "limits    jobs<=" +
          MAX_JOBS +
          "  concurrency<=" +
          MAX_CONCURRENCY +
          "  images<=16  n<=4  timeout=" +
          Math.round(TIMEOUT_MS / 1000) +
          "s  ref<=" +
          Math.round(MAX_REFERENCE_BYTES / 1024 / 1024) +
          "MB",
        "",
        "usage",
        ...USAGE,
        "",
        "ratio       " + RATIOS.join("  "),
        "resolution  " + RESOLUTIONS.join("  ") + "  只对方形生效",
        "size        " + IMAGE_SIZES.slice(1).join("  ") + "  非方形会变形",
      );

      return { content: text(lines.join("\n")) };
    },
  );
}
