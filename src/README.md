# src/ — 模块手册

## 文件索引

| 文件 | 职责 | 关键导出 | 被谁依赖 |
| --- | --- | --- | --- |
| `index.mjs` | 入口，建 McpServer 与 stdio 连接 | 无 | 无 |
| `tools.mjs` | 工具注册与 schema，含 `imagegen_info` 的用法速查文案 | `registerTools` | index |
| `job.mjs` | 任务归一化、路由、单次并发池、进程级在途闸门、错误隔离 | `runJobs` | tools |
| `report.mjs` | 返回排版，纯函数不碰 IO | `formatReport` | tools |
| `upstream.mjs` | SSE 客户端与模型探测 | `callUpstream`、`probeModels` | job, tools |
| `storage.mjs` | 目标文件解析、独占落盘、参考图编码、尺寸读取 | `resolveTargetFile`、`resolveOutputDir`、`saveResultItems`、`toImageReference`、`writeUnique`、`sanitizeName`、`imageSize` | job |
| `size.mjs` | 尺寸与比例归一 | `resolveSize`、`withComposition` | job |
| `config.mjs` | 环境变量、路径、常量 | 全量常量 | 所有模块 |

## 依赖方向

`index` → `tools` → `job` → `{size, storage, upstream}` → `config`。
禁止反向 import。

## 变更影响路由

- 改落盘逻辑 → 同步 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 防错清单，补 selftest。
- 改 `output` 语义 → 三处同步：本文件、[../README.md](../README.md) 输出目录一节、`info` 的 `OUTPUT` 段。
- 改工具 schema → 同步 [../README.md](../README.md) 参数表；新增顶层默认参数必须同时进 `defaults`。
- 改 `PARAMS` / `OUTPUT` / `DISPLAY_*` 文案 → 那是 agent 唯一的用法与排版入口，改完同步 [../README.md](../README.md)。
- 改排版 → 补 selftest 的排版用例，注意中文双宽、多行错误、路径正斜杠。
- 改工具名 → 同步 [../install.ps1](../install.ps1) 收尾提示、[../README.md](../README.md)、[../AGENTS.md](../AGENTS.md)。
- 改上游客户端 → 跑 integration，假上游覆盖 SSE、CRLF、回传原图三种情况。
- 新增环境变量 → 同步 `config.mjs`、[../README.md](../README.md)、[../install.ps1](../install.ps1) 三处。

## 规则

见 [AGENTS.md](AGENTS.md)。
