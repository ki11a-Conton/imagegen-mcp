// 离线自测：不联网，只验证纯逻辑。
// 运行：node test/selftest.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSize, withComposition } from "../src/size.mjs";
import { extFromBuffer, imageSize, resolveOutputDir, sanitizeName, writeNewFile } from "../src/storage.mjs";
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

await check("构图拼进提示词", () => {
  assert.equal(withComposition("画猫", ""), "画猫");
  assert.match(withComposition("画猫", "横向构图"), /画猫[\s\S]*横向构图/);
});

// --- 目录解析 ---
await check("不给参数落到默认 output 根", () => {
  const dir = resolveOutputDir({});
  assert.ok(dir.length > 0);
  assert.ok(!dir.endsWith("generated-images"));
});

await check("folder 追加子目录，支持多级", () => {
  const root = resolveOutputDir({ output_dir: "C:/tmp/out" });
  const sub = resolveOutputDir({ output_dir: "C:/tmp/out", folder: "rabbit/refs" });
  assert.ok(sub.startsWith(root));
  assert.match(sub, /rabbit[\\/]refs$/);
});

await check("folder 拒绝路径穿越", () => {
  assert.throws(() => resolveOutputDir({ folder: "../etc" }));
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

// --- 落盘去重 ---
await check("同名不覆盖，自动加后缀", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagegen-selftest-"));
  try {
    const first = await writeNewFile(dir, { name: "shot", ext: ".png" }, Buffer.from("a"));
    const second = await writeNewFile(dir, { name: "shot", ext: ".png" }, Buffer.from("b"));
    assert.match(first, /shot\.png$/);
    assert.match(second, /shot-2\.png$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check("恶意 name 不会写出目标目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagegen-selftest-"));
  try {
    const path = await writeNewFile(dir, { name: "../../escaped", ext: ".png" }, Buffer.from("x"));
    assert.ok(path.startsWith(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check("不给 name 时文件名带随机量", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagegen-selftest-"));
  try {
    const first = await writeNewFile(dir, { prefix: "image", index: 0, ext: ".png" }, Buffer.from("a"));
    const second = await writeNewFile(dir, { prefix: "image", index: 0, ext: ".png" }, Buffer.from("b"));
    assert.notEqual(first, second);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  jobs: [{ model: "gpt-image-2.5" }],
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
  batch.jobs = [{ model: "gpt-image-2.5" }, { model: "gpt-image-2.5" }];
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
  batch.jobs = [{ model: "gpt-image-2" }, { model: "gpt-image-2.5" }];
  batch.results = [batch.results[0], { ...batch.results[0], index: 1 }];
  assert.match(formatReport(batch, { root: "D:/out" }), /model=mixed/);
});

// --- 结果 ---
if (failures.length > 0) {
  console.log(passed + " passed, " + failures.length + " failed");
  for (const item of failures) console.log("  FAIL  " + item.name + ": " + item.message);
  process.exit(1);
}
console.log(passed + " passed");
