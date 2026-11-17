# 决策：托管块补 `inject: [credentials]`（2026-11-17）

状态：生效

## 问题

0.11.0 起的托管块用了 `${credential:CHATGPT2API_API_KEY}` 与 `expandTemplates: true`，
但没声明 `inject: [credentials]`。DSH 启动时报：

```
mcp-imagegen (@deepseek-ai/dsh-mcp-client): Error: MCP credential templates require a credentials provider
```

终端只多一句 `dsh: warning: 1 entry did not activate`，`mcp__imagegen__*` 工具一个都不出现。

根因在 `@deepseek-ai/dsh-mcp-client` 的 `McpTemplateBinding` 构造函数：只要配置里出现
凭据引用（`refs.size > 0`），它就 `ctx.get('credentials')`，取不到直接抛。`ctx.get` 是严格模式，
只返回**提供方 fiber 已激活**的服务。而条目上的 `inject` 是加载阶段的等待声明——
不声明，插件可能在凭据服务就绪之前就开始 apply，于是稳定地取不到。

`dsh-mcp-manager` 的 README 把这条写成了明文契约：「只要条目可能用模板，就为该行加上
`inject: [credentials]`」。官方自己挂 manager 时就这么写（`dsh-web-app` 的 `mcp-manager` 行）。

## 决策

1. **`renderBlock` 固定输出 `inject: [credentials]`**，与 `expandTemplates: true` 成对出现。
   两块本来就是一件事，不该由使用者记得补。
2. **识别第二种旧格式**：`needsCredentialInject(text)` 在「块里有 `${credential:`、却没声明
   `credentials`」时返回 true。`setup.mjs` 据此打印一行提示，重写块本身就是迁移。
3. **不动 profile 的挂载形态**：仍然是单独一条 `dsh-mcp-client` 行，不改成 `mcp-manager.servers`。

## 替代方案（否决）

- **改走 `mcp-manager` 的 `config.servers`**：这是 Web/Desktop 更正统的挂载点，且那行自带
  `inject: [credentials]`，看着更「官方推荐」。否决理由是两条硬伤：① profile 的
  `cordis.patch.yml` 会**整段替换** `servers` 映射，用户用 Settings 加的服务器会被整片冲掉；
  ② `mcp-manager` 只挂在 web/desktop 捆绑里，而 `setup.mjs` 要支持任意 profile
  （tui、headless 都在 `listProfiles` 的返回里），写一条不存在的行等于制造加载失败。
- **把项目做成 `dsh.bundle` 包，用 `ctx.mcpManager.register()` 注册**：最「插件化」，
  但要改掉「支持任意 DSH_HOME、不依赖插件管理器」的定位，与 2026-11-16 那条决策的否决理由一致，
  继续留作后续。
- **去掉模板，回退成明文密钥**：等于撤销 2026-11-16 的整条决策。
- **在 `setup.mjs` 里事后手改已有行的 YAML**：托管块本来就是整块替换的，
  专门加一段「往已有块里插一行」的分支只会多一条要维护的路径。
- **不加 `inject`，改成把密钥塞进 `env` 让用户自己 export**：MCP 的 stdio 子进程环境会洗掉
  名字含 `KEY|TOKEN|SECRET|PASSWORD` 的变量，这条路根本走不通（2026-11-16 已记录）。

## 影响

- 托管块多两行注释与 `inject:` 段；`renderBlock` 的调用方不需要改签名。
- 已经是新格式的块再跑一次 `setup.mjs` 会从 `unchanged` 变成 `replaced`（补上 inject），之后回到幂等。
- 受影响的老用户重跑一次安装即修复，不必手工编辑 profile。
- 版本按 minor bump 到 `0.12.0`：托管块结构是使用者能观察到的契约变更。
