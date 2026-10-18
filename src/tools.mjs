// 工具面：两个工具，命名对齐（一个动作、一个查询）。
//   create_images   执行：批量生图 / 改图
//   info            查询：参数、输出位置、展示规范、当前配置
//
// 描述只写「什么时候用、最容易踩的一条」，具体技巧放 info 的输出。
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
  output: z
    .string()
    .optional()
    .describe(
      "输出文件的完整绝对路径，含文件名与扩展名，例如 E:/图/兔子/三视图.png。" +
        "父目录自动创建，落盘后不需要再重命名。n 大于 1 时派生 三视图-2.png、三视图-3.png。" +
        "同名已存在时自动加 -2，不覆盖。省略则落到默认目录并自动命名。",
    ),
  n: z.number().int().min(1).max(4).optional().describe("这一组出几张，默认 1。"),
  ratio: z.enum(RATIOS).optional().describe("画面比例，默认 1:1。横竖版用它，不要用 size。"),
  resolution: z.enum(RESOLUTIONS).optional().describe("清晰度档，只对方形生效。"),
  size: z.enum(IMAGE_SIZES).optional().describe("精确像素。只有用户点名像素时用，非方形会变形。"),
  quality: qualityEnum.optional().describe("质量档。上游无差异，一般不用传。"),
  model: z.enum(IMAGE_MODELS).optional().describe("图片模型。四个名字在上游同一个 auto 路由。"),
  folder: z.string().optional().describe("未给 output 时的分类子目录，相对默认输出根，支持 a/b 多级。"),
  output_dir: z
    .string()
    .optional()
    .describe("未给 output 时的输出根目录，绝对路径。默认 <项目根>/output，只是缺省值。"),
});

// 用法与排版规范。放在查询工具的输出里，而不是塞进工具描述：
// 描述写长了会被略读，技巧放这里才能被按需查到。

/** 参数速查。 */
const PARAMS = [
  "批量        jobs: [{prompt}, {prompt}]  一次调用跑多组，自动并发",
  "只要一张    单任务可用顶层 prompt 简写，不必写 jobs",
  "文生图      job 不带 images",
  "图生图      job 带 images，最多 16 张，第一张是被改的主体",
  '横竖版      ratio: "16:9" 或 "9:16"     不要用 size，会变形',
  '清晰度      resolution: "2k"            只对方形生效',
  "同题多张    n: 2 到 4",
  "重活降并发  多张大参考图的图生图很重，并发降到 1 到 2 更稳",
  "自动重试    502 / 503 / 504 / 524 会退避重试，仍失败就是上游过载",
];

/** 输出位置。每个任务独立，默认只是缺省值，不是限制。 */
const OUTPUT = [
  '指定文件    output: "E:/图/兔子/三视图.png"  完整绝对路径，父目录自动建',
  "多张        n 大于 1 时派生 三视图-2.png、三视图-3.png",
  '只定目录    output_dir: "E:/图" 加 folder: "兔子"  仍自动命名',
  "默认        <项目根>/output 自动命名，仅作缺省值",
  "不覆盖      同名已存在时自动加 -2",
  "独立性      output 逐任务生效，同一批里各写各的",
];

/** 展示规范。图片怎么排才不会被渲染破坏。 */
const DISPLAY_RULES = [
  "图片独立成段     前后各留一个空行，否则会被并进文字段落或标题",
  "一格只放一个元素 要么一张图，要么一段文字；单元格内不能换行，HTML 标签不解析",
  "图文相邻不用表格 改用普通段落：文字、空行、图片、空行",
  "表格只有两种    纯文字表，或「文字列 + 图列」的组合网格",
  "图宽等于列宽     图列越多每张越小；只有一列图列时最大",
  "说明写进表头     单元格放不下说明时，表头行是该列唯一能写字的位置",
  "只用纯 Markdown  不用任何 HTML 标签",
  "路径用正斜杠 /   反斜杠在 Markdown 里是转义符",
  "感叹号决定形式   ![](...) 直接出图，[](...) 只出可点文字",
  "方括号不是图注   [] 里是 alt，图加载失败才显示，要配文就另起一段",
];

/** 模板 T1 到 T5。看图时选一个，不要混用。 */
const DISPLAY_TEMPLATES = [
  "T1 图文流      图最大、每张带文字时用，不用表格",
  "               <文字> 空行 ![](<路径>) 空行 <文字>",
  "               图注写在图片外，不要塞进方括号",
  "T2 文字加图列  文字与图并排、图仍要大",
  "               | <文字> | <图> |",
  "T3 一行多图    一行文字对多张图",
  "               | <文字> | <图> | <图> |",
  "T4 多图网格    多图同屏对比，文字放表头",
  "               | <文字> | <文字> |  下一行每格一张图",
  "T5 图加纯文字表 既要看细节又要清单，图逐张铺开、表格只放文字",
];

/** 选型一句话。 */
const DISPLAY_PICK = [
  "图最大每张带字 T1 / 文字与图并排 T2 / 一行文字对多图 T3",
  "多图对比 T4 / 细节与清单并存 T5 / 一格内图文混排做不到，改 T1",
];

export function registerTools(server) {
  server.registerTool(
    "create_images",
    {
      title: "批量生图 / 改图",
      description:
        "生成或修改图片。任务带 images 走图生图，不带走文生图，多任务自动并发。\n" +
        "返回可直接粘贴的 Markdown 图片引用。参数或排版不确定先调 info。",
      inputSchema: {
        jobs: z
          .array(jobSchema)
          .min(1)
          .max(MAX_JOBS)
          .optional()
          .describe("任务数组，最多 " + MAX_JOBS + " 个。只有一个任务时改用顶层 prompt 简写。"),
        prompt: z.string().optional().describe("单任务简写：画什么。仅在 jobs 为空时生效。"),
        images: z.array(z.string()).max(16).optional().describe("单任务简写：参考图路径。"),
        output: z.string().optional().describe("单任务简写：输出文件完整绝对路径，含文件名。"),
        n: z.number().int().min(1).max(4).optional().describe("所有任务的默认张数。"),
        folder: z.string().optional().describe("所有任务的默认分类子目录。"),
        output_dir: z.string().optional().describe("所有任务的默认输出根目录，任意绝对路径。"),
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
            ? [{ prompt: args.prompt, images: args.images, output: args.output }]
            : [];

      const batch = await runJobs(rawJobs, defaults, args.concurrency);
      return { content: text(formatReport(batch, { root: OUTPUT_ROOT })) };
    },
  );

  server.registerTool(
    "info",
    {
      title: "查参数、输出位置与展示规范",
      description:
        "返回参数速查、输出位置规则、Markdown 展示规范与模板、当前配置与连通性。\n" +
        "不确定参数怎么传、图片要放哪、多张图怎么排才不被渲染破坏，先调这个。",
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
        "ratio       " + RATIOS.join("  "),
        "resolution  " + RESOLUTIONS.join("  ") + "  只对方形生效",
        "size        常用 1024x1024 2048x2048 2560x1440 3840x2160；非方形会变形",
        "",
        "params",
        ...PARAMS,
        "",
        "output",
        ...OUTPUT,
        "",
        "display",
        ...DISPLAY_RULES,
        "",
        "templates",
        ...DISPLAY_TEMPLATES,
        "",
        "pick",
        ...DISPLAY_PICK,
      );

      return { content: text(lines.join("\n")) };
    },
  );
}
