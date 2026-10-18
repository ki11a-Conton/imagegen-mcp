# imagegen-mcp — 维护索引

## 全局规则

- 架构与不可破坏的约束 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 决策与依据 → [.agents/notes/](.agents/notes/)
- 模块手册 → [src/README.md](src/README.md) · [test/README.md](test/README.md)
- 改代码前先读该目录的 `AGENTS.md`，那里是规则层。

## 常用命令

- `npm test` — 全部离线测试，不联网、不需要密钥。
- `npm run verify` — lint + format 检查 + emoji 检查 + 测试，提交前跑这个。
- `npm run lint` / `npm run format` — ESLint 与 Prettier，项目本地安装。
- `node src/index.mjs` — 直接起 stdio server，调试用。

检查选择：改源码 → `npm run verify`；改文档 → 链接校验；改 `package.json` → 全套。

## 验证快照

- CI：`.github/workflows/ci.yml`，矩阵 ubuntu + windows × node 20 / 22 / 24。
- 离线测试：selftest 24 项 + integration 13 项。
- 真实上游并发实测：文生图 6 / 8 / 12 路全成功，图生图 8 路全成功。12 路未触顶。
- 并发等价性：集成测试覆盖「1 次调用 2 组」与「2 次调用各 1 组」，两者峰值并发一致，落盘各 2 张。
- 全局闸门：压力用例确认多次调用的在途总量不突破上限。

## 待办

- [ ] 补一个 `output_dir` 指向项目外的用例，确认仍拒绝越界文件名。
- [ ] 并发闸门默认值 4 偏保守，实测 12 路仍成功，考虑上调默认或改为自适应。

## 活跃坑

- `.ps1` 必须是 UTF-8 with BOM。用普通写文件工具改写会丢 BOM，PowerShell 5.1 按 GBK 解码直接语法错。
- `install.ps1` 里不能写未加括号的 `'key: ' + $value`。PowerShell 逗号比加号绑得紧，会拆成两个数组元素，YAML 直接解析失败。
- PowerShell 的 `$Home` 是只读自动变量，函数参数不能叫这个名字。
- `report.mjs` 里中文文件名必须留在最后一列，放中间会把 ASCII 列对齐撑歪。
- 改完 `install.ps1` 要用 PowerShell 5.1 与 7 各跑一次。
- 上游调用必须走 `callUpstreamLimited`。直接调 `callUpstream` 会绕过进程级闸门，多次调用的总量失控。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 对外门面：能力、安装、工具用法 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 设计约束、数据流、防错清单 |
| [src/README.md](src/README.md) | 模块职责、导出、变更影响路由 |
| [src/AGENTS.md](src/AGENTS.md) | 源码目录规则层 |
| [test/README.md](test/README.md) | 测试覆盖范围与运行方式 |
| [test/AGENTS.md](test/AGENTS.md) | 测试目录规则层 |
| [.agents/notes/](.agents/notes/) | 决策与依据记录 |
