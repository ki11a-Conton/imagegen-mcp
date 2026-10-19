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
  MAX_GLOBAL_CONCURRENCY,
  MAX_JOBS,
  MAX_REFERENCE_BYTES,
  MAX_RETRIES,
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
      '写到哪：带图片扩展名才算给文件命名，不带就当文件夹，省略则自动命名。例 "兔子"（目录）/ "兔子/三视图.png"（文件）。',
    ),
  n: z.number().int().min(1).max(4).optional().describe("这一组出几张，默认 1。"),
  ratio: z.enum(RATIOS).optional().describe("画面比例，默认 1:1。横竖版用它，不要用 size。"),
  resolution: z.enum(RESOLUTIONS).optional().describe("清晰度档，只对方形生效。"),
  size: z.enum(IMAGE_SIZES).optional().describe("精确像素。只有用户点名像素时用，非方形会变形。"),
  quality: qualityEnum.optional().describe("质量档。上游无差异，一般不用传。"),
  model: z.enum(IMAGE_MODELS).optional().describe("图片模型。四个名字在上游同一个 auto 路由。"),
});

// 用法与排版规范。放在查询工具的输出里，而不是塞进工具描述：
// 描述写长了会被略读，技巧放这里才能被按需查到。

/**
 * 中文是双宽字符，按字符数补空格会把列撑歪。按显示宽度补齐。
 * 列表统一用 [标签, 说明] 或 [标签, [多行]] 的形式，由 columns 渲染。
 */
const displayWidth = (text) =>
  [...text].reduce(
    (sum, char) =>
      sum +
      (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/.test(char) ? 2 : 1),
    0,
  );

function columns(rows) {
  const width = Math.max(...rows.map(([label]) => displayWidth(label)));

  return rows.flatMap(([label, rest]) => {
    const pad = " ".repeat(width - displayWidth(label) + 2);
    const [first, ...more] = Array.isArray(rest) ? rest : [rest];
    return [label + pad + first, ...more.map((line) => " ".repeat(width + 2) + line)];
  });
}

/** 参数速查。 */
const PARAMS = columns([
  ["批量", "jobs: [{prompt}, {prompt}]  一次调用跑多组，自动并发"],
  ["只要一张", "单任务可用顶层 prompt 简写，不必写 jobs"],
  ["文生图", "job 不带 images"],
  ["图生图", "job 带 images，最多 16 张，第一张是被改的主体"],
  ["横竖版", 'ratio: "16:9" 或 "9:16"     不要用 size，会变形'],
  ["清晰度", 'resolution: "2k"            只对方形生效'],
  ["同题多张", "n: 2 到 4"],
  ["重活降并发", "多张大参考图的图生图很重，并发降到 1 到 2 更稳"],
  ["自动重试", "502 / 504 / 524 会退避重试；503 带 task_interrupted 是服务端超时判定，不重试"],
]);

/** 输出位置。只有一个参数 output，靠路径形态区分文件与文件夹。 */
const OUTPUT = columns([
  ["一条规则", "带图片扩展名才是给它命名，不带就是文件夹"],
  ["省略", '{"prompt": "一只兔子"}      落默认目录，文件名自动'],
  ["给目录", '"output": "兔子"            落 兔子/，文件名自动'],
  ["给绝对目录", '"output": "E:/图/兔子"      指哪落哪，文件名自动'],
  ["给文件", '"output": "兔子/三视图.png" 就叫 三视图.png'],
  ["要命名", "必须带图片后缀，漏了会被当成文件夹"],
  ["后缀", "只是「这是文件」的开关，不决定格式：写 .png 收到 JPEG 仍存 .jpg"],
  ["多张", "n 大于 1 时派生 -2 -3"],
  ["不覆盖", "同名已存在时自动加 -2"],
  ["逐任务", "每个任务各写各的"],
  ["相对路径", "按输出根解析，爬出会报错"],
]);

/** 直接可抄的调用。agent 最容易卡在「参数长什么样」，给例子比给规则有效。 */
const EXAMPLES = columns([
  ["一张图", '{"prompt": "白底三视图，橘黄色兔子"}'],
  ["多组", '{"jobs": [{"prompt": "正面"}, {"prompt": "侧面", "ratio": "16:9"}]}'],
  ["改图", '{"prompt": "背景换成雪山日落，主体不变", "images": ["D:/refs/a.jpg"]}'],
  ["指定文件", '{"prompt": "...", "output": "E:/图/兔子/三视图.png"}'],
  ["分类目录", '{"prompt": "...", "output": "兔子"}'],
  ["目录加命名", '{"prompt": "...", "output": "兔子/三视图.png"}'],
  ["同题多张", '{"prompt": "...", "n": 4}'],
]);

/** 展示规范。图片怎么排才不会被渲染破坏。 */
const DISPLAY_RULES = columns([
  ["图片独立成段", "前后各留一个空行，否则会被并进文字段落或标题"],
  ["一格只放一个元素", "要么一张图，要么一段文字；单元格内不能换行，HTML 标签不解析"],
  ["图文相邻不用表格", "改用普通段落：文字、空行、图片、空行"],
  ["表格只有两种", "纯文字表，或「文字列 + 图列」的组合网格"],
  ["图宽等于列宽", "图列越多每张越小；只有一列图列时最大"],
  ["说明写进表头", "单元格放不下说明时，表头行是该列唯一能写字的位置"],
  ["只用纯 Markdown", "不用任何 HTML 标签"],
  ["路径用正斜杠 /", "反斜杠在 Markdown 里是转义符"],
  ["感叹号决定形式", "![](...) 直接出图，[](...) 只出可点文字"],
  ["方括号不是图注", "[] 里是 alt，图加载失败才显示，要配文就另起一段"],
]);

/** 模板 T1 到 T5。看图时选一个，不要混用。 */
const DISPLAY_TEMPLATES = columns([
  [
    "T1 图文流",
    [
      "图最大、每张带文字时用，不用表格",
      "<文字> 空行 ![](<路径>) 空行 <文字>",
      "图注写在图片外，不要塞进方括号",
    ],
  ],
  ["T2 文字加图列", ["文字与图并排、图仍要大", "| <文字> | <图> |"]],
  ["T3 一行多图", ["一行文字对多张图", "| <文字> | <图> | <图> |"]],
  ["T4 多图网格", ["多图同屏对比，文字放表头", "| <文字> | <文字> |  下一行每格一张图"]],
  ["T5 图加纯文字表", ["既要看细节又要清单，图逐张铺开、表格只放文字"]],
]);

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
        output: z
          .string()
          .optional()
          .describe('单任务简写：写到哪，规则同任务里的 output。例 "兔子" / "E:/图/兔子/三视图.png"。'),
        n: z.number().int().min(1).max(4).optional().describe("所有任务的默认张数。"),
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
        output: args.output,
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
          "  gate=" +
          MAX_GLOBAL_CONCURRENCY +
          "  retries=" +
          MAX_RETRIES +
          "  images<=16  n<=4  timeout=" +
          Math.round(TIMEOUT_MS / 1000) +
          "s  ref<=" +
          Math.round(MAX_REFERENCE_BYTES / 1024 / 1024) +
          "MB",
        "",
        "ratio       " + RATIOS.join("  "),
        "resolution  " + RESOLUTIONS.join("  ") + "  只对方形生效",
        "size        只推荐方形 1024x1024 2048x2048 3840x3840；非方形请改用 ratio，硬传会变形",
        "",
        "examples    直接改参数就能用",
        ...EXAMPLES,
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
