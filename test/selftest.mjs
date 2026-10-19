// 离线自测：不联网，只验证纯逻辑。
// 运行：node test/selftest.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveSize, withComposition } from "../src/size.mjs";
import { IMAGE_SIZES, OUTPUT_ROOT, SQUARE_SIZES } from "../src/config.mjs";
import { extFromBuffer, imageSize, resolveOutput, sanitizeName, writeUnique } from "../src/storage.mjs";
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

await check("绝对目录指哪落哪", () => {
  const target = resolveOutput({ output: "C:/tmp/out/sub" });
  assert.equal(target.file, "");
  assert.equal(target.dir, resolve("C:/tmp/out/sub"));
});

await check("绝对文件路径照用，父目录取父级", () => {
  const target = resolveOutput({ output: "E:/图/兔子/三视图.png" });
  assert.match(target.file.replaceAll("\\", "/"), /E:\/图\/兔子\/三视图\.png$/);
  assert.match(target.dir.replaceAll("\\", "/"), /E:\/图\/兔子$/);
});

await check("末尾斜杠一定是文件夹，哪怕写成 .png", () => {
  const target = resolveOutput({ output: "E:/图/兔子.png/" });
  assert.equal(target.file, "");
  assert.match(target.dir.replaceAll("\\", "/"), /E:\/图\/兔子\.png$/);
});

await check("带点但不是图片扩展名 → 仍是文件夹", () => {
  const target = resolveOutput({ output: "E:/图/v1.2" });
  assert.equal(target.file, "");
  assert.match(target.dir.replaceAll("\\", "/"), /E:\/图\/v1\.2$/);
});

await check("大写扩展名同样识别为文件", () => {
  const target = resolveOutput({ output: "E:/图/兔子/三视图.PNG" });
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
  batch.jobs = [{ model: "gpt-image-2.5" }, { model: "gpt-image-2.5" }];
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

// --- 结果 ---
if (failures.length > 0) {
  console.log(passed + " passed, " + failures.length + " failed");
  for (const item of failures) console.log("  FAIL  " + item.name + ": " + item.message);
  process.exit(1);
}
console.log(passed + " passed");
