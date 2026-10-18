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

/** 路径用尖括号包住，中文与空格都不会破坏 Markdown 语法。 */
const imageRef = (file) => `![${basename(file.path)}](<${file.path}>)`;

/**
 * 每张一行给引用，不预设排版。
 * 想看并排就自己包一层表格，单张就直接发一行。
 */
function markdownBlock(files) {
  if (files.length === 0) return [];

  const lines = files.map(imageRef);
  if (files.length > 1) {
    const sample = files.slice(0, 2).map(imageRef).join(" | ");
    lines.push("", `并排示例：| ${sample} |`);
  }
  return lines;
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
  const { results, concurrency, ms, jobs } = batch;
  const succeeded = results.filter(({ ok }) => ok);
  const failed = results.filter(({ ok }) => !ok);
  const files = succeeded.flatMap(({ files }) => files);

  const models = [...new Set(jobs.map(({ model }) => model))];
  const modelLabel = models.length === 1 ? models[0] : "mixed";

  const lines = [
    `${succeeded.length}/${results.length} ok  ${fmtSeconds(ms)}  concurrency=${concurrency}  model=${modelLabel}`,
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
      ...files.map((file) => `  ${file.path}  (${fmtDims(file)}, ${fmtBytes(file.bytes)})`),
    );
  }

  return lines.join("\n");
}
