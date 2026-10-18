<div align="center">

# imagegen-mcp

把 chatgpt2api 的生图与改图能力接给 DSH。

[![CI](https://github.com/ki11a-Conton/imagegen-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ki11a-Conton/imagegen-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.node-version)

</div>

DSH 自身没有生图工具，模型只能回「我没有生图能力」。这个 MCP server 把 chatgpt2api 的图片接口暴露成工具，并把图片落盘到本地。

## 能力

- 一次调用跑多个任务，进程内自动并发，不必为了并发派多个子 agent。
- 并发分两层：每次调用自己的 worker 池，整个进程还有一道在途闸门，两种用法效果一致。
- 任务带参考图就是图生图，不带就是文生图，自动路由，调用方不判断接口。
- 图片默认落到项目 `output/`，可按子目录分类、可直接指定文件名。
- 绝不覆盖已有文件：并发同一秒完成也不会互相覆盖。
- 返回里带好可直接粘贴的 Markdown 图片引用，单张一行，并排与否自定。
- 固定走 SSE，经 Cloudflare 隧道不会被 100 秒源站超时掐成 524。

## 安装

```powershell
./install.ps1 -ApiKey sk-xxxx
```

脚本自动探测 Node、DSH 主目录和 profile，拷贝文件、装依赖，并把 `mcp-imagegen` 配置块写进
`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`。重启 DSH 后工具可用。

重复安装原地替换同一个配置块，不会重复追加。PowerShell 5.1 与 7 都支持。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-ApiKey` | chatgpt2api 的用户密钥，不填则 YAML 里留占位符 |
| `-BaseUrl` | 默认 `http://127.0.0.1:3000/v1`，漏 `/v1` 会自动补 |
| `-Profile` | 有多个 profile 时指定，缺省优先 `web` |
| `-DshHome` | 默认 `$env:DSH_HOME` 或 `~/.dsh` |
| `-TargetDir` | 默认 `<DSH_HOME>/mcp/imagegen-mcp` |
| `-NodePath` | 自动探测失败时手动指定 node.exe |
| `-OutputDir` | 覆盖默认输出根目录 |
| `-SkipDeps` | 跳过 npm install |
| `-SkipConfig` | 只拷文件，不写 DSH 配置 |

## 工具

### create_images

一次调用跑一批任务。任务里给 `images` 就是图生图，不给就是文生图。

```jsonc
{
  "jobs": [
    { "prompt": "白底三视图，橘黄兔子的左侧面、正面、右侧面", "ratio": "16:9", "folder": "rabbit", "name": "三视图" },
    { "prompt": "把背景换成雪山日落，主体和构图不变", "images": ["D:/refs/rabbit.jpg"], "folder": "rabbit", "name": "雪山" }
  ],
  "concurrency": 3
}
```

顶层参数是所有任务的默认值，任务级同名字段覆盖。

| 参数 | 说明 |
| --- | --- |
| `jobs` | 任务数组，最多 8 个，并发执行 |
| `prompt` / `images` / `name` | 只有一个任务时的顶层简写 |
| `folder` | 输出根下的子目录，支持 `a/b` 多级，写相对路径 |
| `output_dir` | 绝对路径，指哪落哪，不会自动追加子目录 |
| `ratio` | `1:1` `16:9` `9:16` `4:3` `3:4` `3:2` `2:3` |
| `resolution` | `1k` `2k` `4k`，只对方形真正生效 |
| `size` | 精确像素，用户点名像素时才用 |
| `n` | 每个任务出几张，1 到 4 |
| `quality` | `auto` `low` `medium` `high`，上游实测无差异 |
| `model` | 图片模型，四个名字在上游是同一个 auto 路由 |
| `concurrency` | 单次调用的并发，默认 3，上限 6 |

任务级字段：`prompt` `images` `name` `n` `ratio` `resolution` `size` `quality` `model` `folder` `output_dir`。

### imagegen_info

查用法与当前配置：用法速查、上游连通性、可用模型、默认输出目录、各项上限。

参数不确定、想确认上游是否在线、想知道图片落在哪，先调这个。

## 返回格式

```text
3/3 ok  59.3s  concurrency=3  model=gpt-image-2.5
out  D:/ProjectSomething/imagegen-mcp/output/live

#  type  status  time   size       file
1  gen   ok      57.1s  1254x1254  live/青柑橘.png
2  gen   ok      51.5s  1254x1254  live/枫叶.png
3  gen   ok      59.2s  1312x1199  live/贝壳.png
```

表格后面依次是可直接粘贴的图片引用、以及绝对路径清单。

图片引用每张独立一行，直接发就行；想并排展示再自己包一层表格，输出里给了示例。
排版方式不强制。

## 输出目录

默认 `<项目根>/output/`，`output/` 已在 `.gitignore` 里。三种改法，优先级由低到高：

1. 环境变量 `IMAGEGEN_OUTPUT_DIR`
2. 工具参数 `output_dir`
3. 任务级 `output_dir`

用 `folder` 分类，例如 `folder: "rabbit/refs"` 落到 `output/rabbit/refs/`。
文件名用 `name` 指定，不给则自动命名；重名自动加 `-2` `-3`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHATGPT2API_API_KEY` | 无 | 必需 |
| `CHATGPT2API_BASE_URL` | `http://127.0.0.1:3000/v1` | 指向公网隧道时要带 `/v1` |
| `IMAGEGEN_OUTPUT_DIR` | `<项目根>/output` | 输出根目录 |
| `IMAGEGEN_DEFAULT_MODEL` | `gpt-image-2.5` | 默认模型 |
| `IMAGEGEN_TIMEOUT_MS` | `600000` | 我们这边放弃等待的时间，写错时回落默认值 |
| `IMAGEGEN_MAX_CONCURRENCY` | `4` | 整个进程同时在途的上游请求上限 |

## 哪些能调，哪些由服务端决定

### 我们这边能调

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 进程在途上限 | `IMAGEGEN_MAX_CONCURRENCY` | 默认 4。实测 12 路仍成功，12 不是边界，只是没继续往上测 |
| 单次调用并发 | `concurrency` 参数 | 默认 3，上限 6 |
| 单次调用任务数 | `jobs` 数组 | 最多 8 |
| 每组张数 | `n` | 1 到 4 |
| 我们这边等多久 | `IMAGEGEN_TIMEOUT_MS` | 默认 600 秒 |
| MCP 客户端等多久 | DSH 的 `toolCallTimeoutMs` | 默认配 660 秒 |
| 输出目录、文件名、分类 | `output_dir` `name` `folder` | 逐次或逐任务覆盖 |

### 服务端说了算

| 项 | 由什么决定 | 后果 |
| --- | --- | --- |
| 真正能等多久 | `image_stream_timeout_secs + image_poll_timeout_secs + 30` | 出厂 170 秒，本机调到 360 秒。超过返回 503，**我们调自己的超时没用** |
| 2K / 4K 是否达标 | `image_upscale_enabled` | 关着就只给约 1254 的边长 |
| 实际分辨率 | 上游自己决定 | 请求 `1024x1024` 实得 `1254x1254` |
| 每组回几张 | 上游 | 有时多回一张候选，落盘会全部保留 |
| 是否回传原图 | 上游 | 偶尔把参考图原样当结果，返回里会告警 |

**关键**：我们的超时比服务端大，所以实际生效的是服务端那个。
单张超过服务端 deadline 会先收到 503，调 `IMAGEGEN_TIMEOUT_MS` 不解决问题。

## 尺寸与比例

尺寸是**通过提示词**传给上游的，上游不严格遵守：实测请求 `1024x1024` 返回 `1254x1254`。

- 方形（`ratio` 为 `1:1` 或不传）按 `resolution` 下发像素。
- 非方形不下发像素，改为把构图要求写进提示词，由上游出对应比例。
- 显式 `size` 照传像素，非方形会变形，返回里会警告。

2K/4K 依赖服务端 `image_upscale_enabled=true`，且是 Lanczos 放大而不是重绘。

## 安全边界

- 图片只写到本地输出目录，不经过任何第三方。
- 上游地址与密钥由你自己在 DSH 配置里给，本仓库不含任何密钥。
- 参考图只接受图片扩展名，路径穿越会被拒绝。

## 已知限制

- 图生图单张 2 到 6 分钟，偶尔上游回传卡住并最终 504，重试即可。
- 上游偶尔会把参考图原样回传，返回里会标注「与参考图字节相同」，那张要丢弃。
- 单张参考图上限 30MB（服务端硬上限 50MB）。
- 模型名四个在上游都落到同一个 auto 路由，属别名。
- `quality` 只写进提示词，上游不遵守。

## 开发

```bash
npm ci
npm test          # 离线测试，不联网、不需要密钥
npm run verify    # lint + format 检查 + emoji 检查 + 测试
```

维护者文档地图见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)
