# imagegen-mcp 架构说明

## 目标

把 chatgpt2api 的图片生成与编辑能力暴露给 DSH。
DSH 自身没有生图工具，模型只能回「我没有生图能力」。

## 不可破坏的约束

- 传输固定 SSE。经 Cloudflare 免费版隧道时，非流式必被 100 秒源站超时掐成 524。
- stdout 只能有 JSON-RPC 帧。任何日志走 stderr，否则污染协议流。
- 落盘绝不覆盖已有文件。并发与重名靠随机量与独占创建解决，不靠调用方自律。
- 方形才下发像素尺寸。非方形靠提示词约束构图，避免上游方图被服务端硬拉变形。
- 超时以服务端 deadline 为准。我们自己的超时更大，改它不解决 503。

## 谁定边界

| 项 | 归属 | 备注 |
| --- | --- | --- |
| 并发 | 我们 | 服务端不暴露限制，实测 12 路仍成功 |
| 工具超时 | 我们 | 默认 600 秒，比服务端大，通常不生效 |
| 生成耗时上限 | 服务端 | 三段相加，出厂 170 秒，本机 360 秒 |
| 实际分辨率 | 服务端 | 依赖 `image_upscale_enabled` 与上游自身行为 |
| 每组产出张数 | 服务端 | 可能多回候选 |

细节见 `.agents/notes/2026-10-18-并发与超时边界.md`。

## 数据流

```text
tools.mjs        收参数，合并顶层默认值与任务级覆盖
  job.mjs        归一化 → 路由（gen / edit）→ 单次并发池 → 进程级在途闸门
    size.mjs     解析 size / resolution + ratio
    storage.mjs  解析输出目录、参考图转 data URL、独占落盘
    upstream.mjs 组 payload、调 chatgpt2api、解析 SSE
  report.mjs     排版返回
```

依赖只自上而下：tools → job → {size, storage, upstream} → config。
report 是纯函数，不碰 IO，也不反向依赖上层。

## 关键决策

每条的背景与替代方案见 `.agents/notes/`。

- 工具收敛为 `create_images`（执行）与 `info`（查询）两个，批量与单次走同一条路径。
- 自动路由：任务带 `images` 走 `/images/edits`，不带走 `/images/generations`。
- 并发分两层：单次调用一个 worker 池（默认 3 路），整个进程再有一个在途闸门（默认 4 路）。
- 两层并发保证「N 个 agent 各调 1 次」与「1 个 agent 调 1 次带 N 组任务」对上游压力一致。
- 单任务失败收敛成 `{ ok: false }`，不中断整批；归一化失败也不连累其他任务。
- 输出默认 `<项目根>/output`。任务可给 `output`（完整绝对文件路径，含扩展名）直接定名定址。
- 没给 `output` 时用 `output_dir` 加 `folder`，文件名自动生成。
- 每个任务的输出互相独立，同一批里各写各的。`n` 大于 1 时派生 `-2` `-3`。
- 重名不覆盖：同名已存在时自动加 `-2` `-3`。
- 上游回传原图时按 sha256 逐字节识别，在返回里告警，避免被当成「已改好」。

## 防错清单

- 改 `storage.mjs` 的 `writeUnique` 前先想清并发语义：必须保留 `flag: "wx"` 与重试。
- 改 `upstream.mjs` 的 SSE 解析要保留 CRLF 归一。有些代理发 `\r\n\r\n`，只按 `\n\n` 切会完全切不开。
- 改 `report.mjs` 时文件名必须留在最后一列。中文是双宽字符，放中间会把 ASCII 列的对齐撑歪。
- 表格式返回里的错误文本要先压成单行，多行报错会把表格撑破。
- 新增顶层默认参数时，必须同时加进 `inputSchema` 和 `defaults`。只加一处会被静默丢弃。
- 上游调用必须走 `callUpstreamLimited`，不要直接调 `callUpstream`。绕过闸门会让多次调用的在途总量失控。

## 契约

- 工具返回是纯文本 Markdown：表格 + 图片引用 + 绝对路径清单。
- 图片引用每张一行，路径转正斜杠（反斜杠是 Markdown 转义符），排版不强制。
- 任务之间完全独立：参考图、模型、比例、张数、输出目录、文件名逐任务生效。
- 工具描述只写「何时用」与最容易踩的一条，具体技巧放 `info` 的输出里。
- 展示规范以 `info` 的 `display` 段为准：图片独立成段、一格只放一个元素、图文相邻不用表格、说明写表头、只用纯 Markdown、路径用正斜杠。
- 方括号是 alt 不是图注：要配文另起一段，要可点链接去掉感叹号。
- `env` 只认七个变量：`CHATGPT2API_API_KEY`、`CHATGPT2API_BASE_URL`、`IMAGEGEN_OUTPUT_DIR`、`IMAGEGEN_DEFAULT_MODEL`、`IMAGEGEN_TIMEOUT_MS`、`IMAGEGEN_MAX_CONCURRENCY`、`IMAGEGEN_MAX_RETRIES`。
- 网关类错误（502 503 504 524）必须走重试，且错误文本要压成一行：网关返回整页 HTML，原样塞进返回会撑爆表格。
  唯一的例外是 503 带 `task_interrupted`：那是服务端 deadline 判定，重试只会再撞同一条截止线。
- 单张参考图上限 30MB（服务端硬上限 50MB，base64 还有约 1/3 膨胀）。
- 文件名扩展名由字节魔数决定，不信任上游声称的格式。
