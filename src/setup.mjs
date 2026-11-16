#!/usr/bin/env node
// 把 imagegen-mcp 挂进 DSH 的 profile，并保证密钥只以引用形式出现在配置里。
//
// 旧装法（明文密钥写在 cordis.patch.yml 的托管块里）会被就地识别：值搬进
// <DSH_HOME>/.credentials.yaml 的 refs，配置改写为 ${credential:…} 模板。
// 再跑一次是幂等的：已经是新格式就什么都不写。
//
// 重装时没显式给的参数沿用上一版块里的值，用户自己加的环境变量原样保留，
// 所以「再装一遍」不会悄悄改掉已调好的配置。
//
// 用法：
//   node src/setup.mjs                    # 自动探测 DSH 主目录与 profile
//   node src/setup.mjs --dry-run          # 只打印将要做什么
//   node src/setup.mjs --api-key sk-xxx   # 顺手把密钥写进凭据库

import { join } from "node:path";
import { parseArgs } from "node:util";

import { BASE_URL, DEFAULT_MODEL, PROJECT_ROOT, TIMEOUT_MS } from "./config.mjs";
import {
  DEFAULT_REF,
  DEFAULT_SERVER_NAME,
  applyBlock,
  backupOnce,
  credentialsPath,
  detectLegacySecret,
  findForeignEntry,
  listProfiles,
  maskSecret,
  patchPath,
  pickProfile,
  readBlockEnv,
  readCredential,
  readText,
  renderBlock,
  resolveDshHome,
  scrubSecret,
  upsertCredential,
  writeText,
} from "./dsh-config.mjs";

/** 这几个键由参数决定，其余用户自己加的一律原样带走。 */
const MANAGED_ENV = new Set([
  DEFAULT_REF,
  "CHATGPT2API_BASE_URL",
  "IMAGEGEN_DEFAULT_MODEL",
  "IMAGEGEN_TIMEOUT_MS",
  "IMAGEGEN_OUTPUT_DIR",
]);

const say = (text = "") => process.stdout.write(text + "\n");
const step = (text) => say("==> " + text);
const detail = (text) => say("    " + text);
const note = (text) => say("    !!  " + text);
const ok = (text) => say("    OK  " + text);

const { values } = parseArgs({
  options: {
    "dsh-home": { type: "string", default: "" },
    profile: { type: "string", default: "" },
    ref: { type: "string", default: DEFAULT_REF },
    "api-key": { type: "string", default: "" },
    "base-url": { type: "string", default: "" },
    model: { type: "string", default: "" },
    "timeout-ms": { type: "string", default: "" },
    "output-dir": { type: "string", default: "" },
    "server-name": { type: "string", default: DEFAULT_SERVER_NAME },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  say(`用法: node src/setup.mjs [选项]

  --dsh-home <路径>    DSH 主目录，默认 $DSH_HOME 或 ~/.dsh
  --profile <名字>     目标 profile，默认自动探测（多个候选时优先 web）
  --ref <名字>         凭据引用名，默认 ${DEFAULT_REF}
  --api-key <密钥>     写进凭据库；省略则沿用配置里的旧明文，再没有就只留引用
  --base-url <地址>    上游 /v1 地址，省略则沿用上一版配置，默认 ${BASE_URL}
  --model <名字>       默认模型，省略则沿用上一版配置，默认 ${DEFAULT_MODEL}
  --timeout-ms <毫秒>  单次上游超时，省略则沿用上一版配置，默认 ${TIMEOUT_MS}
  --output-dir <路径>  默认落盘目录，省略则沿用上一版配置
  --server-name <名>   MCP server 名，默认 ${DEFAULT_SERVER_NAME}
  --dry-run            只打印计划，不落盘
  --force              覆盖凭据库里已有的同名值
  -h, --help           显示本帮助`);
  process.exit(0);
}

const dryRun = values["dry-run"];
const ref = values.ref;

const dshHome = resolveDshHome({ dshHome: values["dsh-home"] });
const profiles = listProfiles(dshHome);
const profile = pickProfile(profiles, values.profile);

step(dryRun ? "probe (dry-run)" : "probe");
detail("dsh       " + dshHome);

if (!profile) {
  detail("profiles  " + (profiles.length > 0 ? profiles.join(", ") : "（无）"));
  note("找不到可写的 profile，配置写入跳过");
  note("先启动一次 DSH 生成 profile，或用 --profile 指定");
  process.exit(0);
}
detail("profile   " + profile);

const target = patchPath(dshHome, profile);
const storePath = credentialsPath(dshHome);
const patchText = readText(target);

const foreign = findForeignEntry(patchText);
if (foreign) {
  fail(
    `cordis.patch.yml 第 ${foreign} 行已经有一个 mcp-imagegen 条目，但不在托管块里。\n` +
      "    再插一块会让 DSH 报 duplicate loader entry id，所以没有动它。\n" +
      "    请手工把那条改写成引用，或删掉后重跑本脚本。",
  );
}

// 上一版块里的值，作为「没显式给参数」时的默认，重装不会抹掉已调好的配置。
const previous = readBlockEnv(patchText);
const baseUrl = normalizeBaseUrl(values["base-url"] || previous.CHATGPT2API_BASE_URL || BASE_URL);
const model = values.model || previous.IMAGEGEN_DEFAULT_MODEL || DEFAULT_MODEL;
const timeoutMs = Number(values["timeout-ms"] || previous.IMAGEGEN_TIMEOUT_MS || TIMEOUT_MS);
const outputDir = values["output-dir"] || previous.IMAGEGEN_OUTPUT_DIR || "";
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms 必须是正整数");

// 密钥来源：命令行 > 配置里的旧明文。两个都没有时只写引用，值留给用户自己填。
const legacy = detectLegacySecret(patchText, ref);
const explicitKey = Boolean(values["api-key"]);
const secret = values["api-key"] || legacy?.value || "";

step("credentials");
let storeText = null;
if (secret) {
  const result = upsertCredential(readText(storePath), ref, secret, { force: values.force });
  const preview = maskSecret(secret);

  if (result.action === "kept") {
    detail("kept      refs." + ref + " 已是这个值（" + preview + "）");
  } else if (result.action === "conflict") {
    note("凭据库里已有 refs." + ref + "（" + maskSecret(result.existing) + "），与待写入值不同");
    note("按「后填的为准」没有覆盖；要强制换掉加 --force");
  } else {
    storeText = result.text;
    const from = explicitKey ? "--api-key" : `cordis.patch.yml 第 ${legacy.line} 行`;
    detail(`${result.action === "updated" ? "updated  " : "moved    "} ${from} → refs.${ref}（${preview}）`);
  }
} else {
  const existing = readCredential(readText(storePath), ref);
  if (existing) detail("kept      refs." + ref + " 已在凭据库里（" + maskSecret(existing) + "）");
  else note("凭据库里还没有 refs." + ref + "，填好之前调用会 401");
}

step("config");
const block = renderBlock({
  command: process.execPath,
  entry: join(PROJECT_ROOT, "src", "index.mjs"),
  cwd: PROJECT_ROOT,
  ref,
  baseUrl,
  model,
  timeoutMs,
  outputDir,
  serverName: values["server-name"],
  extraEnv: Object.fromEntries(Object.entries(previous).filter(([name]) => !MANAGED_ENV.has(name))),
});
const applied = applyBlock(patchText, block);

if (dryRun) {
  detail("would write " + target + "（" + applied.action + "）");
  if (storeText !== null) detail("would write " + storePath);
  say("");
  say(applied.text.trimEnd());
  say("");
  step("dry-run");
  detail("没有落盘，去掉 --dry-run 才会写入");
  process.exit(0);
}

if (storeText !== null) {
  const backup = backupOnce(storePath);
  writeText(storePath, storeText);
  ok(storePath);
  if (backup) detail("backup    " + backup);
}

if (applied.action === "unchanged") {
  detail("unchanged " + target + "（已是最新）");
} else {
  const backup = backupOnce(target);
  writeText(target, applied.text);
  ok(applied.action + "  " + target);
  if (backup) {
    // 备份是回退点，但它此刻还留着刚搬走的明文密钥，抹掉再留着。
    if (legacy) writeText(backup, scrubSecret(readText(backup), ref));
    detail("backup    " + backup + (legacy ? "（已抹掉明文密钥）" : ""));
  }
}

step("done");
detail("重启 DSH 生效；密钥只留在凭据库，配置里只有引用");
if (!readCredential(readText(storePath), ref)) {
  detail("还没有密钥：用 --api-key 传，或直接编辑 " + storePath);
}

function normalizeBaseUrl(raw) {
  const trimmed = String(raw).trim().replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? trimmed : trimmed + "/v1";
}

function fail(message) {
  process.stderr.write("    !!  " + message + "\n");
  process.exit(1);
}
