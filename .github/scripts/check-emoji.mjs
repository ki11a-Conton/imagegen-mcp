// CI 用：拒绝受版本控制的文本文件里出现 emoji。
// 扫描源码、测试、文档、配置；跳过 node_modules、.git、output。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "output", "dist"]);
const EXTENSIONS = new Set([".mjs", ".js", ".json", ".md", ".yml", ".yaml", ".ps1"]);
const EMOJI = /\p{Extended_Pictographic}/u;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : EXTENSIONS.has(extname(name)) ? [full] : [];
  });
}

const hits = walk(".").flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((line, index) => ({ file, line: index + 1, text: line }))
    .filter(({ text }) => EMOJI.test(text)),
);

if (hits.length === 0) {
  console.log("no emoji found");
  process.exit(0);
}

for (const { file, line, text } of hits) {
  console.error(`${relative(".", file)}:${line}  ${text.trim().slice(0, 120)}`);
}
console.error(`found ${hits.length} line(s) containing emoji`);
process.exit(1);
