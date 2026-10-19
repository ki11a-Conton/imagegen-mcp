// 任务编排：归一化 → 自动路由 → 并发执行。
//
// 任务带 images 走 /images/edits（图生图），不带走 /images/generations（文生图）。
// 调用方不必判断接口，也不必为了并发派多个子 agent。
//
// 并发分两层：
//   1. 单次调用自己的 worker 池（concurrency 参数）。
//   2. 整个进程共享的在途上游请求闸门。
// 第 2 层保证「N 个 agent 各调 1 次」与「1 个 agent 调 1 次带 N 组任务」对上游压力一致。

import { DEFAULT_CONCURRENCY, DEFAULT_MODEL, MAX_CONCURRENCY, MAX_GLOBAL_CONCURRENCY } from "./config.mjs";
import { resolveSize, withComposition } from "./size.mjs";
import { callUpstream } from "./upstream.mjs";
import { referenceHash, resolveOutput, saveResultItems, toImageReference } from "./storage.mjs";

// --- 进程级并发闸门 ---

let inFlight = 0;
const waiting = [];

function acquire() {
  if (inFlight < MAX_GLOBAL_CONCURRENCY) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) {
    // 名额直接转交，inFlight 不变。
    next();
    return;
  }
  inFlight -= 1;
}

/** 受全局闸门约束的上游调用。 */
async function callUpstreamLimited(payload, path) {
  await acquire();
  try {
    return await callUpstream(payload, path);
  } finally {
    release();
  }
}

/** 合并顶层默认值与单个任务，得到一份可直接执行的描述。 */
function normalizeJob(raw, defaults, index) {
  const job = { ...defaults, ...raw };

  const prompt = String(job.prompt ?? "").trim();
  if (!prompt) throw new Error(`第 ${index + 1} 个任务缺少 prompt。`);

  const images = [...[job.image], ...(Array.isArray(job.images) ? job.images : [job.images])].filter(
    (item) => typeof item === "string" && item.trim(),
  );

  const size = resolveSize({ size: job.size, resolution: job.resolution, ratio: job.ratio });
  const target = resolveOutput({ output: job.output });

  return {
    index,
    prompt: withComposition(prompt, size.composition),
    images,
    route: images.length > 0 ? "edit" : "generate",
    model: job.model || DEFAULT_MODEL,
    size: size.size,
    sizeNote: size.note,
    quality: job.quality && job.quality !== "auto" ? job.quality : "",
    n: job.n || 1,
    targetFile: target.file,
    dir: target.dir,
  };
}

/** 执行单个任务。任何异常都收敛成 { ok: false }，不拖垮整批。 */
async function runJob(job) {
  const startedAt = Date.now();

  try {
    const references = job.route === "edit" ? await Promise.all(job.images.map(toImageReference)) : [];
    const echoHashes = new Set(references.map(referenceHash).filter(Boolean));

    const payload = {
      model: job.model,
      prompt: job.prompt,
      n: job.n,
      response_format: "b64_json",
      ...(job.route === "edit" && { images: references }),
      ...(job.size && { size: job.size }),
      ...(job.quality && { quality: job.quality }),
    };

    // 走全局闸门，多个工具调用之间共享在途配额。
    const result = await callUpstreamLimited(
      payload,
      job.route === "edit" ? "/images/edits" : "/images/generations",
    );

    const { saved, items } = await saveResultItems(result, {
      targetFile: job.targetFile,
      dir: job.dir,
      prefix: job.route === "edit" ? "edited" : "image",
    });

    // 上游偶尔把参考图原样回传，逐字节比对能识别出来。
    const echoed = saved.filter((file) => echoHashes.has(file.sha256)).length;

    return {
      index: job.index,
      ok: true,
      route: job.route,
      dir: job.dir,
      files: saved.map((file, position) => ({
        ...file,
        revisedPrompt: items?.[position]?.revised_prompt ?? "",
      })),
      note: [
        job.sizeNote,
        echoed > 0 ? `${echoed} 张与参考图字节相同（上游回传原图，提示词未生效），请丢弃重试` : "",
      ]
        .filter(Boolean)
        .join(" "),
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      index: job.index,
      ok: false,
      route: job.route,
      dir: job.dir,
      error: String(error?.message ?? error),
      ms: Date.now() - startedAt,
    };
  }
}

/** 固定并发池，结果按提交顺序返回。 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * 跑一批任务。
 * 单个任务归一化失败只让那一个失败，不影响其余任务。
 *
 * @param {object[]} rawJobs     原始任务数组
 * @param {object}   defaults    顶层默认值（model / ratio / resolution / size / quality / n / output）
 * @param {number}   concurrency 并发路数
 */
export async function runJobs(rawJobs, defaults, concurrency) {
  if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
    throw new Error("jobs 不能为空，至少给一个任务。");
  }

  // 归一化阶段就把每个任务的成败定下来，坏任务不连累好任务。
  const prepared = rawJobs.map((raw, index) => {
    try {
      return { ok: true, job: normalizeJob(raw, defaults, index) };
    } catch (error) {
      return {
        ok: false,
        failure: {
          index,
          ok: false,
          route: "generate",
          dir: "",
          error: String(error?.message ?? error),
          ms: 0,
        },
      };
    }
  });

  const runnable = prepared.filter((entry) => entry.ok).map((entry) => entry.job);
  const limit = Math.max(
    1,
    Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, MAX_CONCURRENCY, runnable.length),
  );

  const startedAt = Date.now();
  const finished = await runWithConcurrency(
    runnable.map((job) => () => runJob(job)),
    limit,
  );

  // 按原始顺序拼回结果。
  const queue = [...finished];
  const results = prepared.map((entry) => (entry.ok ? queue.shift() : entry.failure));

  const jobs = prepared.filter((entry) => entry.ok).map((entry) => entry.job);
  return { results, jobs, concurrency: limit, gate: MAX_GLOBAL_CONCURRENCY, ms: Date.now() - startedAt };
}
