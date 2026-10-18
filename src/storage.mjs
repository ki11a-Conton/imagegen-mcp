// 落盘：目录解析、文件名去重、参考图编码、图片尺寸读取。

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { IMAGE_MIME_BY_EXT, MAX_REFERENCE_BYTES, OUTPUT_ROOT } from "./config.mjs";

export const sha256Of = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** 从字节判断真实格式。b64_json 不保证是 PNG，后缀不能写死。 */
export function extFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";

  const magic = {
    ".png": buffer[0] === 0x89 && buffer.subarray(1, 4).toString("latin1") === "PNG",
    ".jpg": buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    ".webp":
      buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WEBP",
    ".gif": buffer.subarray(0, 3).toString("latin1") === "GIF",
    ".bmp": buffer[0] === 0x42 && buffer[1] === 0x4d,
  };

  return Object.entries(magic).find(([, hit]) => hit)?.[0] ?? "";
}

/** 读图片宽高。只解析头部，拿不到返回 null。 */
export function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 26) return null;

  try {
    switch (extFromBuffer(buffer)) {
      case ".png":
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };

      case ".webp": {
        const chunk = buffer.subarray(12, 16).toString("latin1");
        if (chunk === "VP8X") {
          return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
        }
        if (chunk === "VP8 ") {
          return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
        }
        if (chunk === "VP8L") {
          const bits = buffer.readUInt32LE(21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        return null;
      }

      case ".jpg": {
        let offset = 2;
        while (offset < buffer.length - 9) {
          if (buffer[offset] !== 0xff) {
            offset += 1;
            continue;
          }
          const marker = buffer[offset + 1];
          const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
          if (isSof) {
            return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
          }
          offset += 2 + buffer.readUInt16BE(offset + 2);
        }
        return null;
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * 文件名只允许单段，禁止路径分隔符与 Windows 非法字符。
 * 去掉首尾的点与空格，避免生成 ".", "..", " ." 这类危险名字。
 */
export function sanitizeName(name) {
  return (
    String(name ?? "")
      .replace(/[\\/:*?"<>|]/g, "")
      // 控制字符单独处理，避免在正则字面量里写 \u0000-\u001f 触发 no-control-regex。
      .split("")
      .filter((char) => char.charCodeAt(0) > 31)
      .join("")
      .replace(/^[. ]+|[. ]+$/g, "")
      .trim()
  );
}

/**
 * 解析目标目录。
 * - output_dir 省略：用 IMAGEGEN_OUTPUT_DIR，兜底 <项目根>/output
 * - folder 给出：在其下再开一层，支持 a/b 多级，拒绝绝对路径与 ..
 */
export function resolveOutputDir({ output_dir, folder } = {}) {
  const root = output_dir ? resolve(output_dir) : OUTPUT_ROOT;

  const segments = String(folder ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);

  const invalid = segments.find((segment) => segment === "." || segment === "..");
  if (invalid) throw new Error(`folder 不能包含 . 或 ..：${folder}`);

  return segments.length > 0 ? resolve(root, ...segments) : root;
}

/** 时间戳只到秒，唯一性靠随机量。 */
function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * 解析任务的目标文件。
 *
 * - 给了 output：按绝对文件路径走，父目录自动创建。相对路径按默认根解析。
 *   这就是「任务自带文件名」，落盘后不需要再重命名。
 * - 没给 output：落到默认目录，自动命名。
 *
 * 返回 { file, dir }：file 为空表示用自动命名。
 */
export function resolveTargetFile({ output, output_dir, folder } = {}) {
  const dir = resolveOutputDir({ output_dir, folder });
  const wanted = String(output ?? "").trim();
  if (!wanted) return { file: "", dir };

  const file = resolve(wanted);
  return { file, dir: dirname(file) };
}

/**
 * 独占创建，绝不覆盖已有文件。
 * 撞名自动退化成 name-2 / name-3。
 */
export async function writeUnique(dir, baseName, ext, buffer) {
  await mkdir(dir, { recursive: true });

  for (const attempt of Array.from({ length: 12 }, (_, i) => i)) {
    const name = attempt === 0 ? baseName : `${baseName}-${attempt + 1}`;
    const target = join(dir, `${name}${ext}`);
    try {
      await writeFile(target, buffer, { flag: "wx" });
      return target;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  throw new Error(`无法在 ${dir} 生成不冲突的文件名（同名重试 12 次仍冲突）`);
}

/** 把调用方给的文件路径拆成目录与主干名，扩展名以实际字节为准。 */
function splitTarget(file) {
  const ext = extname(file);
  return {
    dir: dirname(file),
    stem: sanitizeName(basename(file, ext)) || "image",
  };
}

/** 单张落盘。b64_json 与 url 两种来源都支持。 */
async function saveOne(item, { targetFile, dir, prefix, index }) {
  const b64 = String(item?.b64_json ?? "").trim();

  const { buffer, sourceUrl } = await (async () => {
    if (b64) return { buffer: Buffer.from(b64, "base64"), sourceUrl: undefined };

    const url = String(item?.url ?? "").trim();
    if (!url) return { buffer: null, sourceUrl: undefined };

    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载生成图失败 ${url}：HTTP ${response.status}`);
    return { buffer: Buffer.from(await response.arrayBuffer()), sourceUrl: url };
  })();

  if (!buffer) return null;

  const ext = extFromBuffer(buffer) || ".png";

  // 显式路径：n 大于 1 时派生 主干-2、主干-3。
  const { baseDir, baseName } = targetFile
    ? (() => {
        const parts = splitTarget(targetFile);
        return {
          baseDir: parts.dir,
          baseName: index === 0 ? parts.stem : `${parts.stem}-${index + 1}`,
        };
      })()
    : {
        baseDir: dir,
        baseName: `${prefix}-${timestamp()}-${index + 1}-${randomUUID().slice(0, 8)}`,
      };

  const path = await writeUnique(baseDir, baseName, ext, buffer);
  const size = imageSize(buffer);

  return {
    path,
    bytes: buffer.length,
    sha256: sha256Of(buffer),
    width: size?.width ?? null,
    height: size?.height ?? null,
    sourceUrl,
  };
}

/**
 * 把上游返回的 data[] 全部落盘。
 * targetFile 为空时按 dir 自动命名。
 */
export async function saveResultItems(result, { targetFile = "", dir, prefix = "image" } = {}) {
  const items = Array.isArray(result?.data) ? result.data : [];
  if (items.length === 0) {
    throw new Error(`上游没有返回图片数据：${JSON.stringify(result).slice(0, 300)}`);
  }

  const saved = [];
  for (const [index, item] of items.entries()) {
    const file = await saveOne(item, { targetFile, dir, prefix, index });
    if (file) saved.push(file);
  }

  if (saved.length === 0) throw new Error("上游返回了条目，但没有一项带 b64_json 或 url。");
  return { saved, items };
}

/** 本地文件转 data: URL。http(s) 与 data: 原样透传。 */
export async function toImageReference(value) {
  const ref = String(value ?? "").trim();
  if (!ref) throw new Error("参考图路径为空。");
  if (/^(data:|https?:\/\/)/i.test(ref)) return ref;

  const filePath = resolve(ref);

  const info = await stat(filePath).catch(() => null);
  if (!info) throw new Error(`读不到参考图：${ref}。请传存在的绝对路径，或 http(s) / data: URL。`);
  if (!info.isFile()) throw new Error(`参考图不是文件：${filePath}`);
  if (info.size === 0) throw new Error(`参考图是空文件：${filePath}`);

  // 只接受图片扩展名，避免把 .env / 私钥之类的东西当参考图发到上游。
  const mime = IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()];
  if (!mime) {
    throw new Error(`参考图扩展名不受支持：${filePath}。只接受 ${Object.keys(IMAGE_MIME_BY_EXT).join(" ")}`);
  }

  if (info.size > MAX_REFERENCE_BYTES) {
    throw new Error(
      `参考图 ${(info.size / 1024 / 1024).toFixed(1)} MB 超过 30MB 上限，请先压缩：${filePath}`,
    );
  }

  const data = await readFile(filePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

/** 取出 data: URL 里的原始字节哈希，用于识别上游原样回传的参考图。 */
export function referenceHash(reference) {
  const at = reference.indexOf("base64,");
  return at < 0 ? "" : sha256Of(Buffer.from(reference.slice(at + 7), "base64"));
}
