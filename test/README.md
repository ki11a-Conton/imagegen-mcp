# test/ — 测试手册

## 文件索引

| 文件 | 类型 | 覆盖 |
| --- | --- | --- |
| `selftest.mjs` | 单元 | 尺寸解析、目录解析、文件名净化、魔数识别、宽高读取、落盘去重、报表排版 |
| `integration.mjs` | 集成 | 起真实 MCP server 走 stdio，覆盖工具调用、批量路由、并发、命名、排版、回传告警、失败隔离 |
| `mock-upstream.mjs` | 夹具 | 假 chatgpt2api，模拟 SSE 协议，不联网 |

## 运行

- `npm run test:unit` — 只跑单元。
- `npm run test:integration` — 只跑集成。
- `npm test` — 两个都跑。
- 全部离线，不需要密钥，不消耗额度。

## 覆盖边界

- 单元：纯逻辑，任何用例都不得请求上游。
- 集成：真实 stdio 协议与真实落盘，用假上游替代网络。
- 未覆盖：真实上游的时序与限流行为，靠手工实跑验证。

## 规则

见 [AGENTS.md](AGENTS.md)。
