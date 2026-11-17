// DSH 侧落盘：定位主目录与 profile、渲染托管块、识别旧明文密钥、凭据库行级 upsert。
//
// 全部是「文本进、文本出」的纯函数，只有 read / backup / write 三个薄 IO，便于离线测试。
// 刻意不引入 YAML 解析器，两处都按行处理：
//   - cordis.patch.yml 里有 !!js 标签，通用解析器读不了；
//   - .credentials.yaml 里有 DSH 自己写的注释，解析后重写会把注释冲掉。
// DSH 官方明确允许直接编辑 .credentials.yaml，它自己会热加载。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * 托管块标记。**不能改**：旧装法写下的就是这两行，改了就认不出旧块，
 * 会在同一个文件里追加第二份 `id: mcp-imagegen`，DSH 直接报 duplicate loader entry id。
 */
export const BLOCK_START = "# >>> imagegen-mcp (managed by install.ps1)";
export const BLOCK_END = "# <<< imagegen-mcp";

export const PATCH_FILE = "cordis.patch.yml";
export const CREDENTIALS_FILE = ".credentials.yaml";
export const DEFAULT_REF = "CHATGPT2API_API_KEY";
export const DEFAULT_SERVER_NAME = "imagegen";
export const DEFAULT_ENTRY_ID = "mcp-imagegen";

// --- 路径 ---

/** DSH 主目录：显式参数 > $DSH_HOME > ~/.dsh。 */
export function resolveDshHome({ dshHome = "", env = process.env, home = homedir() } = {}) {
  return resolve(dshHome || env.DSH_HOME || join(home, ".dsh"));
}

export function patchPath(dshHome, profile) {
  return join(dshHome, "profiles", profile, PATCH_FILE);
}

export function credentialsPath(dshHome) {
  return join(dshHome, CREDENTIALS_FILE);
}

/** 有 cordis.patch.yml 的 profile 才算候选。 */
export function listProfiles(dshHome) {
  const dir = join(dshHome, "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, PATCH_FILE)))
    .map((entry) => entry.name)
    .sort();
}

/** 多个候选时优先 web：那是 DSH 的默认 Web profile。 */
export function pickProfile(profiles, preferred = "") {
  if (preferred) return profiles.includes(preferred) ? preferred : null;
  if (profiles.includes("web")) return "web";
  return profiles[0] ?? null;
}

// --- 托管块 ---

/**
 * 渲染托管块。密钥**永远**只以 `${credential:REF}` 引用出现，明文不再有分支：
 * 值只活在凭据库里，配置里留引用，报错与日志由 mcp-client 自动打码。
 *
 * `extraEnv` 是上一版块里用户自己加的环境变量，原样带过来，
 * 免得每次重装都把它们抹掉。
 */
export function renderBlock({
  command,
  entry,
  cwd,
  ref = DEFAULT_REF,
  baseUrl,
  model,
  timeoutMs,
  outputDir = "",
  serverName = DEFAULT_SERVER_NAME,
  entryId = DEFAULT_ENTRY_ID,
  extraEnv = {},
}) {
  const env = [
    [ref, "${credential:" + ref + "}"],
    ["CHATGPT2API_BASE_URL", baseUrl],
    ["IMAGEGEN_DEFAULT_MODEL", model],
    ["IMAGEGEN_TIMEOUT_MS", String(timeoutMs)],
  ];
  if (outputDir) env.push(["IMAGEGEN_OUTPUT_DIR", toPosix(outputDir)]);
  env.push(...Object.entries(extraEnv));

  return [
    BLOCK_START,
    "- insert:",
    "    - id: " + entryId,
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      # 用了 ${credential:…} 就必须在加载阶段等到凭据提供方，mcp-client 的",
    "      # 构造函数会查 ctx.get('credentials')，缺了这句整条直接加载失败。",
    "      inject:",
    "        - credentials",
    "      config:",
    "        serverName: " + serverName,
    "        transport: stdio",
    "        command: " + yamlScalar(toPosix(command)),
    "        args:",
    "          - " + yamlScalar(toPosix(entry)),
    "        cwd: " + yamlScalar(toPosix(cwd)),
    "        # 让 mcp-client 在运行期把 ${credential:…} 换成凭据库里的真值，",
    "        # 并在报错、日志、工具失败里把换出来的值一律写成 [redacted]。",
    "        expandTemplates: true",
    "        env:",
    ...env.map(([name, value]) => "          " + name + ": " + yamlScalar(value)),
    "        toolCallTimeoutMs: " + (timeoutMs + 60_000),
    BLOCK_END,
  ];
}

/** 替换已有托管块，没有就追加。内容一致时返回 unchanged，不白写文件。 */
export function applyBlock(text, blockLines) {
  const eol = detectEol(text);
  const lines = text ? splitLines(text) : [];
  const block = findBlock(lines);
  const next = blockLines.join(eol);

  if (block) {
    if (lines.slice(block.start, block.end + 1).join(eol) === next) return { text, action: "unchanged" };
    const merged = [...lines.slice(0, block.start), ...blockLines, ...lines.slice(block.end + 1)];
    return { text: merged.join(eol), action: "replaced" };
  }

  const merged = [...lines];
  if (merged.length > 0 && merged[merged.length - 1].trim() !== "") merged.push("");
  merged.push(...blockLines);
  return { text: merged.join(eol) + eol, action: "appended" };
}

/**
 * 块外若已存在 `id: mcp-imagegen`，说明这个 profile 是手写挂载的。
 * 这时再插一块就是重复 id，DSH 会拒绝加载，所以只报告、不擅自改写用户的条目。
 */
export function findForeignEntry(text) {
  const lines = splitLines(text);
  const block = findBlock(lines);
  const pattern = new RegExp("^\\s*-?\\s*id:\\s*" + escapeRegExp(DEFAULT_ENTRY_ID) + "\\s*$");
  for (let i = 0; i < lines.length; i += 1) {
    if (block && i >= block.start && i <= block.end) continue;
    if (pattern.test(lines[i])) return i + 1;
  }
  return null;
}

/**
 * 识别旧格式：托管块里写着明文密钥（老 install.ps1 干的）。
 * 返回 { value, line }，已是引用 / 占位符 / 空值则返回 null。
 */
export function detectLegacySecret(text, ref = DEFAULT_REF) {
  const lines = splitLines(text);
  const block = findBlock(lines);
  if (!block) return null;

  const pattern = new RegExp("^\\s*" + escapeRegExp(ref) + ":\\s*(.*)$");
  for (let i = block.start; i <= block.end; i += 1) {
    const matched = lines[i].match(pattern);
    if (!matched) continue;
    const value = unquote(matched[1].trim());
    if (!value || isReference(value)) return null;
    return { value, line: i + 1 };
  }
  return null;
}

/**
 * 识别第二种旧格式：块里用了 `${credential:…}`，却没有 `inject: [credentials]`。
 *
 * 这种块能写进 profile，但 DSH 加载时会整条失败：
 *   mcp-imagegen (@deepseek-ai/dsh-mcp-client): Error: MCP credential templates
 *   require a credentials provider
 * 因为 mcp-client 在构造函数里就查 `ctx.get('credentials')`，而 `inject` 是
 * 加载阶段的等待声明——不声明它，插件可能在凭据服务就绪之前就开始 apply。
 *
 * 返回 true 表示该块需要重写（重写块本身就是迁移，旧值由 readBlockEnv 带走）。
 */
export function needsCredentialInject(text) {
  const lines = splitLines(text);
  const block = findBlock(lines);
  if (!block) return false;

  let usesTemplate = false;
  let declared = false;
  let insideInject = false;
  for (let i = block.start; i <= block.end; i += 1) {
    const line = lines[i];
    if (line.includes("${credential:")) usesTemplate = true;
    if (/^\s*inject:\s*$/.test(line)) {
      insideInject = true;
      continue;
    }
    if (!insideInject) continue;
    if (/^\s*-\s*credentials\s*$/.test(line)) {
      declared = true;
      insideInject = false;
      continue;
    }
    if (line.trim() !== "" && !/^\s*-/.test(line)) insideInject = false;
  }
  return usesTemplate && !declared;
}

/** 已经是引用、占位符或用户自己的表达式，都不算旧明文。 */
function isReference(value) {
  if (value.startsWith("${credential:")) return true;
  if (value.startsWith("!!js")) return true;
  if (value.startsWith("<") && value.endsWith(">")) return true;
  return false;
}

/** 读出托管块里 `env:` 下的全部键值，用来在重装时沿用上一版的配置。 */
export function readBlockEnv(text) {
  const lines = splitLines(text);
  const block = findBlock(lines);
  if (!block) return {};

  const env = {};
  let inside = false;
  for (let i = block.start; i <= block.end; i += 1) {
    const line = lines[i];
    if (/^\s*env:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    const matched = line.match(/^\s{10,}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!matched) {
      if (line.trim() !== "" && !/^\s*#/.test(line)) inside = false;
      continue;
    }
    env[matched[1]] = unquote(matched[2].trim());
  }
  return env;
}

// --- 凭据库 ---

/** 读出 refs 里某个引用的值，没有返回空串。 */
export function readCredential(text, ref) {
  if (!text) return "";
  const pattern = new RegExp("^\\s+" + escapeRegExp(ref) + ":(?:\\s(.*))?$");
  for (const line of splitLines(text)) {
    const matched = line.match(pattern);
    if (matched) return unquote((matched[1] ?? "").trim());
  }
  return "";
}

/**
 * 行级 upsert：只动 refs 里那一行，别处的注释、顺序、records 段逐字保留。
 *
 * action：
 *   created  — 新建文档或新增一行
 *   updated  — 覆盖了旧值（需要 force）
 *   kept     — 已存在且值相同
 *   conflict — 已存在且值不同，按「用户后填的为准」不覆盖，交给调用方提示
 */
export function upsertCredential(text, ref, value, { force = false } = {}) {
  if (!value) throw new Error("credential value is empty");
  const eol = detectEol(text);

  if (!text.trim()) {
    const lines = ["version: 1", "", "refs:", "  " + ref + ": " + credentialScalar(value)];
    return { text: lines.join(eol) + eol, action: "created" };
  }

  const lines = splitLines(text);
  const pattern = new RegExp("^(\\s+)" + escapeRegExp(ref) + ":(?:\\s(.*))?$");

  for (let i = 0; i < lines.length; i += 1) {
    const matched = lines[i].match(pattern);
    if (!matched) continue;
    const existing = unquote((matched[2] ?? "").trim());
    if (existing === value) return { text, action: "kept" };
    if (!force) return { text, action: "conflict", existing };
    const next = [...lines];
    next[i] = matched[1] + ref + ": " + credentialScalar(value);
    return { text: next.join(eol), action: "updated" };
  }

  const section = findSection(lines, "refs");
  const entry = "  " + ref + ": " + credentialScalar(value);
  if (!section) {
    const next = [...lines];
    if (next.length > 0 && next[next.length - 1].trim() !== "") next.push("");
    next.push("refs:", entry);
    return { text: next.join(eol), action: "created" };
  }

  const next = [...lines];
  next.splice(section.end + 1, 0, entry);
  return { text: next.join(eol), action: "created" };
}

/** 只给眼睛看的预览，绝不回显完整值。 */
export function maskSecret(value) {
  if (!value || value.length < 16) return "***";
  return value.slice(0, 6) + "…" + value.slice(-4);
}

/**
 * 备份里也把明文密钥抹掉：回退点要留的是结构，不是密钥。
 * 值已经搬进凭据库，真要回退重跑一次 setup 就补回来了。
 */
export function scrubSecret(text, ref = DEFAULT_REF) {
  const lines = splitLines(text);
  const block = findBlock(lines);
  if (!block) return text;

  const pattern = new RegExp("^(\\s*" + escapeRegExp(ref) + ":\\s*)(.*)$");
  for (let i = block.start; i <= block.end; i += 1) {
    const matched = lines[i].match(pattern);
    if (!matched) continue;
    const value = unquote(matched[2].trim());
    if (!value || isReference(value)) return text;
    const next = [...lines];
    next[i] = matched[1] + '"<moved to credentials.yaml>"';
    return next.join(detectEol(text));
  }
  return text;
}

// --- 薄 IO ---

export function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** 滚动备份：同名互相覆盖，任何时刻只有最近 1 份，避免主目录堆历史垃圾。 */
export function backupOnce(path) {
  if (!existsSync(path)) return "";
  const backup = path + ".bak";
  copyFileSync(path, backup);
  return backup;
}

/** 先写临时文件再改名，避免中途失败留下半个 YAML 把 DSH 卡在启动失败。 */
export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + ".tmp-" + process.pid;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, path);
}

// --- 内部工具 ---

function splitLines(text) {
  return text.split(/\r?\n/);
}

/** 沿用文件本身的换行风格，空文件按 LF。 */
function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function findBlock(lines) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === BLOCK_START) start = i;
    else if (trimmed === BLOCK_END && start >= 0) end = i;
  }
  return start >= 0 && end > start ? { start, end } : null;
}

/** 找一个顶格 `key:` 段落，返回它的首行与最后一个缩进行（注释与空行不参与定位）。 */
function findSection(lines, key) {
  const start = lines.findIndex((line) => new RegExp("^" + escapeRegExp(key) + ":\\s*$").test(line));
  if (start < 0) return null;
  let end = start;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) {
      end = i;
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    break;
  }
  return { start, end };
}

function unquote(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

/** 配置里的标量一律双引号包裹，密钥里的 # : { } 不会破坏解析。 */
function yamlScalar(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 凭据文件里能裸写就裸写（对齐 DSH 自己的写法），含 YAML 敏感字符才加引号。 */
function credentialScalar(value) {
  return /^[A-Za-z0-9._~+/=@-]+$/.test(value) ? value : yamlScalar(value);
}

function toPosix(path) {
  return String(path).replace(/\\/g, "/");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
