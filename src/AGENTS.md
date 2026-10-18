# src/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

- 依赖只能自上而下：`index` → `tools` → `job` → `{size, storage, upstream}` → `config`。禁止反向 import。
- 日志只能走 `process.stderr`。`stdout` 留给 JSON-RPC 帧。
- 落盘必须保留独占创建（`flag: "wx"`）与重名退化，不允许改成覆盖写。
- 单个任务的异常必须收敛成 `{ ok: false }`，不允许冒泡中断整批。
- 新增顶层工具参数时，同时加进 `inputSchema` 与 `defaults`，只加一处会被静默丢弃。
- 模块职责与导出写 [README.md](README.md)，这里只写约束。
