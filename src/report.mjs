// 返回给 agent 的报告。
//
// 排版原则：
// - 文件名放最后一列，前面全是等宽 ASCII 列（序号/类型/状态/耗时/尺寸），
//   中文文件名不会把对齐撑歪。
// - 表格路径相对输出根，绝对路径单独列。
// - Markdown 图片引用直接给出可粘贴的块：单张一行，多张每行两张的表格。
// - 只在需要时附加提示，不制造噪音。
// - 不使用任何 emoji。

const KB = 1024;

const fmtBytes = (bytes) =>
  !bytes ? "-" : bytes >= KB * KB ? `${(bytes / KB / KB).toFixed(2)}MB` : `${Math.round(bytes / KB)}KB`;

const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

const fmtDims = ({ width, height }) => (width && height ? `${width}x${height}` : "-");

const basename = (path) => path.split(/[\\/]/).pop() ?? "image";

/** 单行化，避免上游多行报错把表格撑破。 */
const oneLine = (value) =>
  String(value ?? "")
    .replaceAll(/[\r\n]+/g, " ")
    .trim();

/** 按路径边界取相对路径，避免 D:/out 误吃 D:/out-old。 */
const relTo = (path, root) => {
  const normalize = (value) => String(value ?? "").replaceAll("\\", "/");
  const [target, base] = [normalize(path), normalize(root)];
  if (!base) return target;

  const prefix = base.endsWith("/") ? base : `${base}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
};

/**
 * 图片引用。
 * - 路径统一转正斜杠：反斜杠在 Markdown 里是转义符。
 * - 外面包尖括号：中文、空格、括号都不会破坏语法。
 */
const imageRef = (file) => {
  const path = String(file.path).replaceAll("\\", "/");
  return `![${basename(path)}](<${path}>)`;
};

/**
 * 每张一行给引用，不预设排版。
 * 排版模板由 info 的 display 段提供，返回里不塞示例，保持干净。
 */
function markdownBlock(files) {
  return files.map(imageRef);
}

/** 等宽列对齐，最后一列自由宽度。 */
function table(rows, headers) {
  const widths = headers.map((_, column) =>
    Math.max(headers[column].length, ...rows.map((row) => String(row[column]).length)),
  );

  const line = (cells) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : String(cell).padEnd(widths[column])))
      .join("  ");

  return [line(headers), ...rows.map(line)];
}

export function formatReport(batch, { root } = {}) {
  const { results, concurrency, gate, ms, jobs } = batch;
  const succeeded = results.filter(({ ok }) => ok);
  const failed = results.filter(({ ok }) => !ok);
  const files = succeeded.flatMap(({ files }) => files);

  const models = [...new Set(jobs.map(({ model }) => model))];
  const modelLabel = models.length === 1 ? models[0] : "mixed";

  // 单次调用的 worker 池可能比进程级闸门还宽，闸门才是真正生效的并发。
  // 只报池上限会让调用方以为自己真的在跑那么多路。
  const concurrencyLabel = gate && gate < concurrency ? `${concurrency}(gate ${gate})` : String(concurrency);

  const lines = [
    `${succeeded.length}/${results.length} ok  ${fmtSeconds(ms)}  concurrency=${concurrencyLabel}  model=${modelLabel}`,
  ];

  const dirs = [...new Set(succeeded.map(({ dir }) => dir))];
  if (dirs.length === 1) lines.push(`out  ${dirs[0]}`);

  const rows = results.map((result) => [
    String(result.index + 1),
    result.route === "edit" ? "edit" : "gen",
    result.ok ? "ok" : "FAIL",
    fmtSeconds(result.ms),
    result.ok ? result.files.map(fmtDims).join(" ") : "-",
    result.ok ? relTo(result.files[0].path, root) : oneLine(result.error),
  ]);

  lines.push("", ...table(rows, ["#", "type", "status", "time", "size", "file"]));

  // 只在需要时提示，不制造噪音。
  const hints = [];

  if (failed.length > 0) {
    hints.push(`  ${failed.length} 个任务失败，已成功的文件保留；失败组可用同样参数重发`);
  }

  for (const { index, note } of succeeded) {
    if (note) hints.push(`  #${index + 1}  ${oneLine(note)}`);
  }

  if (files.length > 1 && dirs.length === 0) {
    hints.push("  多组落在不同目录，引用时注意路径");
  }

  if (hints.length) lines.push("", ...hints);

  if (files.length > 0) {
    lines.push("", "markdown:", ...markdownBlock(files));
    lines.push(
      "",
      "paths:",
      ...files.map(
        (file) => `  ${String(file.path).replaceAll("\\", "/")}  (${fmtDims(file)}, ${fmtBytes(file.bytes)})`,
      ),
    );
  }

  return lines.join("\n");
}
