// 离线自测：不联网，只验证纯逻辑。
// 运行：node test/selftest.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveSize, withComposition, withAnimated } from "../src/size.mjs";
import {
  ANIMATED_DIRECTIVE,
  apiKeyProblem,
  IMAGE_MODELS,
  IMAGE_SIZES,
  OUTPUT_ROOT,
  SQUARE_SIZES,
} from "../src/config.mjs";
import {
  applyBlock,
  detectLegacySecret,
  findForeignEntry,
  maskSecret,
  needsCredentialInject,
  pickProfile,
  readBlockEnv,
  readCredential,
  renderBlock,
  scrubSecret,
  upsertCredential,
} from "../src/dsh-config.mjs";
import {
  countGifFrames,
  extFromBuffer,
  imageSize,
  resolveOutput,
  sanitizeName,
  writeUnique,
} from "../src/storage.mjs";
import { formatReport } from "../src/report.mjs";

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

// --- 尺寸解析 ---
await check("方形加 1k 下发 1024x1024", () => {
  const result = resolveSize({ ratio: "1:1", resolution: "1k" });
  assert.equal(result.size, "1024x1024");
  assert.equal(result.composition, "");
});

await check("不传比例不传档位则不下发像素", () => {
  const result = resolveSize({});
  assert.equal(result.size, "");
  assert.equal(result.composition, "");
});

await check("非方形不下发像素，改走构图提示", () => {
  const result = resolveSize({ ratio: "16:9", resolution: "2k" });
  assert.equal(result.size, "");
  assert.match(result.composition, /16:9/);
  assert.match(result.note, /非方形/);
});

await check("显式 size 优先级最高并警告变形", () => {
  const result = resolveSize({ size: "2560x1440", ratio: "1:1", resolution: "1k" });
  assert.equal(result.size, "2560x1440");
  assert.match(result.note, /变形/);
});

await check("size 为 AUTO 时按未指定处理", () => {
  const result = resolveSize({ size: "AUTO", ratio: "1:1", resolution: "1k" });
  assert.equal(result.size, "1024x1024");
});

await check("大小写 X 的方形尺寸不被误判为变形", () => {
  const result = resolveSize({ size: "2048X2048" });
  assert.equal(result.size, "2048X2048");
  assert.equal(result.note, "", "方形不该给变形警告，实际: " + result.note);
});

await check("resolution=4k 下发的像素必须在 size 白名单里", () => {
  assert.ok(
    IMAGE_SIZES.includes(SQUARE_SIZES["4k"]),
    "4k 会下发 " + SQUARE_SIZES["4k"] + "，但它不在 IMAGE_SIZES 里",
  );
});

await check("构图拼进提示词", () => {
  assert.equal(withComposition("画猫", ""), "画猫");
  assert.match(withComposition("画猫", "横向构图"), /画猫[\s\S]*横向构图/);
});

// --- 动画 GIF：尺寸解析与提示词指令 ---
await check("animated 忽略像素与档位，只保留构图提示", () => {
  const result = resolveSize({ animated: true, size: "2048x2048", resolution: "4k" });
  assert.equal(result.size, "", "动图不该下发像素");
  assert.match(result.note, /动画 GIF/);
});

await check("animated + ratio 非方形仍写构图提示", () => {
  const result = resolveSize({ animated: true, ratio: "16:9" });
  assert.equal(result.size, "");
  assert.match(result.composition, /16:9/);
});

await check("animated 把 GIF 硬约束拼进提示词", () => {
  assert.equal(withAnimated("画猫", false), "画猫");
  const withGif = withAnimated("画猫", true);
  assert.match(withGif, /画猫[\s\S]*动画 GIF[\s\S]*循环播放/);
  assert.ok(withGif.endsWith(ANIMATED_DIRECTIVE), "硬约束必须在提示词末尾");
});

await check("模型白名单为 2.6 系列", () => {
  assert.deepEqual(IMAGE_MODELS, [
    "gpt-image-2",
    "gpt-image-2.6",
    "gpt-image-2.6-flare",
    "gpt-image-2.6-sunburst",
  ]);
});

// --- 输出路径解析（一个参数，靠形态区分文件与文件夹）---
await check("不给 output 落到默认根并自动命名", () => {
  const target = resolveOutput({});
  assert.equal(target.file, "");
  assert.equal(target.dir, OUTPUT_ROOT);
});

await check("不带图片扩展名 → 当文件夹", () => {
  const target = resolveOutput({ output: "兔子" });
  assert.equal(target.file, "");
  assert.equal(target.dir, resolve(OUTPUT_ROOT, "兔子"));
});

await check("带图片扩展名的相对路径 → 当文件", () => {
  const target = resolveOutput({ output: "兔子/三视图.png" });
  assert.match(target.file.replaceAll("\\", "/"), /兔子\/三视图\.png$/);
  assert.equal(target.dir, resolve(OUTPUT_ROOT, "兔子"));
});

// 绝对路径的写法跨平台不同：Windows 认盘符，POSIX 认根斜杠。
const ABS_DIR = process.platform === "win32" ? "C:/tmp/out/sub" : "/tmp/out/sub";
const ABS_FILE = process.platform === "win32" ? "E:/图/兔子/三视图.png" : "/图/兔子/三视图.png";

await check("绝对目录指哪落哪，不嵌套到默认根下", () => {
  const target = resolveOutput({ output: ABS_DIR });
  assert.equal(target.file, "");
  assert.equal(target.dir, resolve(ABS_DIR));
  assert.ok(!target.dir.startsWith(OUTPUT_ROOT), "绝对目录不应再挂到默认根下：" + target.dir);
});

await check("绝对文件路径照用，父目录取父级", () => {
  const target = resolveOutput({ output: ABS_FILE });
  assert.match(target.file.replaceAll("\\", "/"), /图\/兔子\/三视图\.png$/);
  assert.match(target.dir.replaceAll("\\", "/"), /图\/兔子$/);
});

await check("末尾斜杠一定是文件夹，哪怕写成 .png", () => {
  const target = resolveOutput({ output: "图/兔子.png/" });
  assert.equal(target.file, "");
  assert.match(target.dir.replaceAll("\\", "/"), /图\/兔子\.png$/);
});

await check("带点但不是图片扩展名 → 仍是文件夹", () => {
  const target = resolveOutput({ output: "图/v1.2" });
  assert.equal(target.file, "");
  assert.match(target.dir.replaceAll("\\", "/"), /图\/v1\.2$/);
});

await check("大写扩展名同样识别为文件", () => {
  const target = resolveOutput({ output: "图/兔子/三视图.PNG" });
  assert.match(target.file.replaceAll("\\", "/"), /三视图\.PNG$/);
});

await check("相对路径不许爬出输出根", () => {
  assert.throws(() => resolveOutput({ output: "../escaped.png" }));
  assert.throws(() => resolveOutput({ output: "../escaped" }));
});

// --- 文件名净化 ---
await check("文件名去掉路径分隔符", () => {
  assert.equal(sanitizeName("../../escaped"), "escaped");
  assert.equal(sanitizeName("a/b\\c"), "abc");
});

await check("文件名去掉 Windows 非法字符与首尾点", () => {
  assert.equal(sanitizeName('bad:name?*"<>|'), "badname");
  assert.equal(sanitizeName("...hidden..."), "hidden");
});

// --- 文件格式识别 ---
await check("识别 PNG 字节", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(extFromBuffer(bytes), ".png");
});

await check("识别 JPEG 字节", () => {
  assert.equal(extFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), ".jpg");
});

await check("未知字节返回空串", () => {
  assert.equal(extFromBuffer(Buffer.from("not an image at all")), "");
});

// --- 动画 GIF：帧数与宽高 ---
const gifFixture = (frames, width = 2, height = 2) => {
  const head = Buffer.alloc(13);
  head.write("GIF89a", 0, "latin1");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x64, 0x00, 0x00]);
  return Buffer.concat([head, ...Array.from({ length: frames }, () => gce)]);
};

await check("countGifFrames 数 GCE 块", () => {
  assert.equal(countGifFrames(gifFixture(8)), 8);
  assert.equal(countGifFrames(gifFixture(1)), 1);
  assert.equal(countGifFrames(Buffer.from("GIF-not")), 0, "无 GCE 应为 0");
});

await check("countGifFrames 不认识的输入返回 0", () => {
  assert.equal(countGifFrames(Buffer.alloc(4)), 0);
  assert.equal(countGifFrames(Buffer.from("plain text that is not a gif")), 0);
});

await check("读取 GIF 宽高（小端 LSD）", () => {
  assert.deepEqual(imageSize(gifFixture(2, 378, 250)), { width: 378, height: 250 });
});

await check("读取 PNG 宽高", () => {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt8(0x89, 0);
  buffer.write("PNG", 1, "latin1");
  buffer.writeUInt32BE(1672, 16);
  buffer.writeUInt32BE(941, 20);
  assert.deepEqual(imageSize(buffer), { width: 1672, height: 941 });
});

await check("过短或不认识的 buffer 返回 null", () => {
  assert.equal(imageSize(Buffer.alloc(4)), null);
  assert.equal(imageSize(Buffer.from("plain text content here")), null);
});

// 紧凑校验：默认根 + 相对文件路径落在根下。
await check("相对文件路径落在输出根下，不按进程 cwd", () => {
  const target = resolveOutput({ output: "rabbit/三视图.png" });
  assert.match(target.file.replaceAll("\\", "/"), /output\/rabbit\/三视图\.png$/);
});

// --- 落盘去重 ---
await check("同名不覆盖，自动加后缀", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagegen-selftest-"));
  try {
    const first = await writeUnique(dir, "shot", ".png", Buffer.from("a"));
    const second = await writeUnique(dir, "shot", ".png", Buffer.from("b"));
    assert.match(first, /shot\.png$/);
    assert.match(second, /shot-2\.png$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check("文件名净化去掉路径分隔符与非法字符", () => {
  assert.equal(sanitizeName("../../escaped"), "escaped");
  assert.equal(sanitizeName('bad:name?*"<>|'), "badname");
  assert.equal(sanitizeName("...hidden..."), "hidden");
});

// --- 报表排版 ---
const sampleBatch = (overrides = {}) => ({
  results: [
    {
      index: 0,
      ok: true,
      route: "gen",
      dir: "D:/out",
      ms: 1200,
      files: [{ path: "D:/out/三视图.png", width: 1672, height: 941, bytes: 1_500_000 }],
      note: "",
    },
  ],
  jobs: [{ model: "gpt-image-2.6" }],
  concurrency: 1,
  ms: 1200,
  ...overrides,
});

await check("单张输出一行图片引用", () => {
  const text = formatReport(sampleBatch(), { root: "D:/out" });
  assert.match(text, /markdown:/);
  assert.match(text, /!\[三视图\.png\]\(<D:\/out\/三视图\.png>\)/);
});

await check("多张逐行给引用，不预设排版", () => {
  const batch = sampleBatch();
  batch.results = [
    { ...batch.results[0], index: 0 },
    {
      ...batch.results[0],
      index: 1,
      files: [{ path: "D:/out/四视图.png", width: 1672, height: 940, bytes: 1_700_000 }],
    },
  ];
  batch.jobs = [{ model: "gpt-image-2.6" }, { model: "gpt-image-2.6" }];
  const text = formatReport(batch, { root: "D:/out" });

  // 每张各自独立成行。
  assert.match(text, /!\[三视图\.png\]\(<D:\/out\/三视图\.png>\)\n!\[四视图\.png\]/);
  // 不塞表格、不塞示例，排版交给调用方按 info 工具里的模板决定。
  assert.ok(!text.includes("| "));
  assert.ok(!text.includes("markdown (2 per row)"));
});

await check("图片引用路径统一用正斜杠", () => {
  const batch = sampleBatch();
  batch.results[0].files[0].path = "C:\\Users\\me\\out\\三视图.png";
  const text = formatReport(batch, { root: "C:/Users/me/out" });
  assert.match(text, /!\[三视图\.png\]\(<C:\/Users\/me\/out\/三视图\.png>\)/);
  assert.ok(!text.includes("\\"));
});

await check("相对路径按边界裁剪，不吃掉相邻目录", () => {
  const batch = sampleBatch();
  batch.results[0].files[0].path = "D:/out-old/x.png";
  const text = formatReport(batch, { root: "D:/out" });
  assert.match(text, /D:\/out-old\/x\.png/);
});

await check("多行错误压成一行", () => {
  const batch = sampleBatch();
  batch.results = [{ index: 0, ok: false, route: "gen", dir: "D:/out", ms: 5, error: "a\nb\nc" }];
  batch.jobs = [];
  const text = formatReport(batch, { root: "D:/out" });
  assert.ok(!text.split("\n").some((line) => line.trim() === "b"));
  assert.match(text, /a b c/);
});

await check("混合模型标注为 mixed", () => {
  const batch = sampleBatch();
  batch.jobs = [{ model: "gpt-image-2" }, { model: "gpt-image-2.6" }];
  batch.results = [batch.results[0], { ...batch.results[0], index: 1 }];
  assert.match(formatReport(batch, { root: "D:/out" }), /model=mixed/);
});

await check("多组落在不同目录时给出提醒", () => {
  const batch = sampleBatch();
  batch.results = [
    { ...batch.results[0], index: 0, dir: "D:/out" },
    {
      ...batch.results[0],
      index: 1,
      dir: "E:/其它",
      files: [{ path: "E:/其它/四视图.png", width: 800, height: 800, bytes: 200 }],
    },
  ];
  batch.jobs = [{ model: "gpt-image-2.6" }, { model: "gpt-image-2.6" }];
  assert.match(formatReport(batch, { root: "D:/out" }), /多组落在不同目录/);
});

await check("闸门比 worker 池窄时如实标注生效并发", () => {
  const text = formatReport(sampleBatch({ concurrency: 6, gate: 4 }), { root: "D:/out" });
  assert.match(text, /concurrency=6\(gate 4\)/);
});

await check("闸门不比池窄时只报一个数", () => {
  const text = formatReport(sampleBatch({ concurrency: 3, gate: 4 }), { root: "D:/out" });
  assert.match(text, /concurrency=3\s/);
});

await check("动画文件在尺寸列带帧数", () => {
  const batch = sampleBatch();
  batch.results[0].files = [
    { path: "D:/out/dance.gif", width: 378, height: 250, bytes: 140_000, animated: true, frames: 8 },
  ];
  const text = formatReport(batch, { root: "D:/out" });
  assert.match(text, /378x250 8f/);
  assert.match(text, /dance\.gif/);
});

// --- DSH 配置写入与旧格式迁移 ---
const renderFixture = (overrides = {}) =>
  renderBlock({
    command: "E:\\nodejs\\node.exe",
    entry: "C:\\Users\\me\\.dsh\\mcp\\imagegen-mcp\\src\\index.mjs",
    cwd: "C:\\Users\\me\\.dsh\\mcp\\imagegen-mcp",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-image-2.6",
    timeoutMs: 600000,
    ...overrides,
  });

// 旧装法写出来的样子：密钥是明文，且块外还有用户自己的条目与注释。
const LEGACY_PATCH =
  [
    "# 用户自己的注释，必须逐字保留",
    "- id: ui-theme",
    "  config:",
    "    fontSize: 16",
    "",
    "# >>> imagegen-mcp (managed by install.ps1)",
    "- insert:",
    "    - id: mcp-imagegen",
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    "        serverName: imagegen",
    "        transport: stdio",
    '        command: "E:/nodejs/node.exe"',
    "        args:",
    '          - "C:/Users/me/.dsh/mcp/imagegen-mcp/src/index.mjs"',
    '        cwd: "C:/Users/me/.dsh/mcp/imagegen-mcp"',
    "        env:",
    '          CHATGPT2API_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz"',
    '          CHATGPT2API_BASE_URL: "https://api.example.com/v1"',
    '          IMAGEGEN_DEFAULT_MODEL: "gpt-image-2.6"',
    '          IMAGEGEN_TIMEOUT_MS: "600000"',
    "        toolCallTimeoutMs: 660000",
    "# <<< imagegen-mcp",
    "",
    "- id: plugin-market",
    "  config:",
    "    indexes: []",
  ].join("\n") + "\n";

const LEGACY_SECRET_LINE = 18;

const STORE_FIXTURE =
  [
    "version: 1",
    "",
    "refs:",
    "  # 这一行注释要留着",
    "  CPA_API_KEY: cpa-123",
    "  OPENCODE_API_KEY: oc-456",
    "",
    "records:",
    "  llm-pi-ai/openai-codex:",
    "    kind: grant",
    "    payload:",
    "      access: xyz",
  ].join("\n") + "\n";

await check("托管块只写凭据引用，不含明文也不含反斜杠", () => {
  const text = renderFixture().join("\n");
  assert.match(text, /expandTemplates: true/);
  assert.match(text, /CHATGPT2API_API_KEY: "\$\{credential:CHATGPT2API_API_KEY\}"/);
  assert.ok(!text.includes("sk-"), "块里不该出现密钥");
  assert.ok(!text.includes("\\"), "路径必须转正斜杠");
});

// 用了 ${credential:…} 却不声明 inject，DSH 会让整条 mcp-imagegen 加载失败：
//   Error: MCP credential templates require a credentials provider
await check("模板块必须声明 inject: [credentials]", () => {
  const text = renderFixture().join("\n");
  assert.match(text, /^ {6}inject:\n {8}- credentials$/m);
  assert.equal(needsCredentialInject(text), false);
});

await check("缺 inject 的旧块能被识别成待迁移", () => {
  // 就是本次事故里的那一版块：有模板、没有 inject。
  const broken = renderFixture()
    .filter((line) => !/^\s*(inject:|- credentials)$/.test(line))
    .join("\n");
  assert.ok(broken.includes("${credential:"));
  assert.equal(needsCredentialInject(broken), true);
  assert.equal(needsCredentialInject(applyBlock(broken, renderFixture()).text), false);
});

await check("不写模板的块不要求 inject", () => {
  const plain = LEGACY_PATCH;
  assert.ok(!plain.includes("${credential:"));
  assert.equal(needsCredentialInject(plain), false);
});

await check("识别旧格式的明文密钥与行号", () => {
  const found = detectLegacySecret(LEGACY_PATCH);
  assert.equal(found?.value, "sk-abcdefghijklmnopqrstuvwxyz");
  assert.equal(found?.line, LEGACY_SECRET_LINE);
});

await check("新格式不再被当成旧明文", () => {
  const migrated = applyBlock(LEGACY_PATCH, renderFixture()).text;
  assert.equal(detectLegacySecret(migrated), null);
});

await check("占位符与 !!js 表达式都不算旧明文", () => {
  const placeholder = LEGACY_PATCH.replace(
    '"sk-abcdefghijklmnopqrstuvwxyz"',
    '"<填入 chatgpt2api 用户密钥>"',
  );
  const expression = LEGACY_PATCH.replace(
    '"sk-abcdefghijklmnopqrstuvwxyz"',
    "!!js process.env.CHATGPT2API_API_KEY",
  );
  assert.equal(detectLegacySecret(placeholder), null);
  assert.equal(detectLegacySecret(expression), null);
});

await check("替换托管块时块外的注释与条目逐字保留", () => {
  const { text, action } = applyBlock(LEGACY_PATCH, renderFixture());
  assert.equal(action, "replaced");
  assert.ok(text.startsWith("# 用户自己的注释，必须逐字保留\n- id: ui-theme\n"));
  assert.ok(text.includes("- id: plugin-market"));
  assert.equal(text.match(/# >>> imagegen-mcp/g).length, 1);
  assert.equal(text.match(/id: mcp-imagegen/g).length, 1);
});

await check("同一份块再写一次是 unchanged", () => {
  const once = applyBlock(LEGACY_PATCH, renderFixture()).text;
  assert.deepEqual(applyBlock(once, renderFixture()), { text: once, action: "unchanged" });
});

await check("没有托管块时追加，前面补空行", () => {
  const { text, action } = applyBlock("- id: locale\n  config: {}\n", renderFixture());
  assert.equal(action, "appended");
  assert.match(text, /config: \{\}\n\n# >>> imagegen-mcp/);
  assert.ok(text.endsWith("# <<< imagegen-mcp\n"));
});

await check("换行风格沿用原文件", () => {
  const crlf = LEGACY_PATCH.replace(/\n/g, "\r\n");
  const { text } = applyBlock(crlf, renderFixture());
  assert.ok(text.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(text), "不该混进裸 LF");
});

await check("凭据库为空时建出合规文档", () => {
  const { text, action } = upsertCredential("", "CHATGPT2API_API_KEY", "sk-abc");
  assert.equal(action, "created");
  assert.equal(text, "version: 1\n\nrefs:\n  CHATGPT2API_API_KEY: sk-abc\n");
});

await check("新引用插在 refs 段末尾，records 与注释原样保留", () => {
  const { text, action } = upsertCredential(STORE_FIXTURE, "CHATGPT2API_API_KEY", "sk-abc");
  assert.equal(action, "created");
  const lines = text.split("\n");
  assert.equal(lines[lines.indexOf("  OPENCODE_API_KEY: oc-456") + 1], "  CHATGPT2API_API_KEY: sk-abc");
  assert.ok(text.includes("  # 这一行注释要留着"));
  assert.ok(text.includes("records:\n  llm-pi-ai/openai-codex:"));
});

await check("已存在同名同值时不重写", () => {
  const { text, action } = upsertCredential(STORE_FIXTURE, "CPA_API_KEY", "cpa-123");
  assert.equal(action, "kept");
  assert.equal(text, STORE_FIXTURE);
});

await check("已存在同名不同值时默认不覆盖", () => {
  const { text, action, existing } = upsertCredential(STORE_FIXTURE, "CPA_API_KEY", "cpa-999");
  assert.equal(action, "conflict");
  assert.equal(existing, "cpa-123");
  assert.equal(text, STORE_FIXTURE);
});

await check("--force 才覆盖已有值", () => {
  const { text, action } = upsertCredential(STORE_FIXTURE, "CPA_API_KEY", "cpa-999", { force: true });
  assert.equal(action, "updated");
  assert.equal(readCredential(text, "CPA_API_KEY"), "cpa-999");
  assert.ok(text.includes("  OPENCODE_API_KEY: oc-456"), "相邻条目不该被动");
});

await check("含冒号空格的值加引号并能原样读回", () => {
  const value = "sk-a: b #c";
  const { text } = upsertCredential("", "K", value);
  assert.ok(text.includes('K: "sk-a: b #c"'));
  assert.equal(readCredential(text, "K"), value);
});

await check("块外已有同名条目时报出行号", () => {
  assert.equal(findForeignEntry("- id: mcp-imagegen\n  config: {}\n"), 1);
  assert.equal(findForeignEntry(LEGACY_PATCH), null);
});

await check("重装时能读回上一版块里的环境变量", () => {
  const previous = readBlockEnv(LEGACY_PATCH);
  assert.equal(previous.CHATGPT2API_BASE_URL, "https://api.example.com/v1");
  assert.equal(previous.IMAGEGEN_TIMEOUT_MS, "600000");
  assert.equal(previous.IMAGEGEN_MAX_CONCURRENCY, undefined);
});

await check("用户自加的环境变量原样带进新块", () => {
  const text = renderFixture({ extraEnv: { IMAGEGEN_MAX_CONCURRENCY: "8" } }).join("\n");
  assert.match(text, /IMAGEGEN_MAX_CONCURRENCY: "8"/);
});

await check("预览不泄漏完整密钥", () => {
  const masked = maskSecret("sk-abcdefghijklmnopqrstuvwxyz");
  assert.match(masked, /^sk-abc/);
  assert.ok(!masked.includes("mnopqrstuv"));
});

await check("备份里的明文密钥会被抹掉，结构保留", () => {
  const scrubbed = scrubSecret(LEGACY_PATCH);
  assert.ok(!scrubbed.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert.match(scrubbed, /CHATGPT2API_API_KEY: "<moved to credentials.yaml>"/);
  assert.ok(scrubbed.includes("- id: plugin-market"), "块外内容要留着");
  assert.equal(
    scrubSecret(applyBlock(LEGACY_PATCH, renderFixture()).text),
    applyBlock(LEGACY_PATCH, renderFixture()).text,
  );
});

await check("未展开的凭据模板会被启动自检点名", () => {
  assert.match(apiKeyProblem("${credential:CHATGPT2API_API_KEY}"), /expandTemplates/);
  assert.equal(apiKeyProblem("sk-real"), "");
  assert.match(apiKeyProblem(""), /not set/);
});

await check("多 profile 时优先 web", () => {
  assert.equal(pickProfile(["headless", "tui", "web"]), "web");
  assert.equal(pickProfile(["tui"]), "tui");
  assert.equal(pickProfile(["tui"], "web"), null);
  assert.equal(pickProfile([]), null);
});

// --- 结果 ---
if (failures.length > 0) {
  console.log(passed + " passed, " + failures.length + " failed");
  for (const item of failures) console.log("  FAIL  " + item.name + ": " + item.message);
  process.exit(1);
}
console.log(passed + " passed");
