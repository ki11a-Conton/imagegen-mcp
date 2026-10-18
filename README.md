# imagegen-mcp — 给 DeepSeek Harness Desktop 补上生图能力

DSH 自身**没有生图能力**（见下方排查结论），所以模型在对话里只能说「我没有生图工具」。
这个 MCP server 把 chatgpt2api 的图片接口暴露成模型可调用的工具，图片直接落盘到会话工作区。

---

## 一、清晰度支持：1K / 2K / 4K 都支持

### 实测结果（真实产出分辨率）

| 请求 `size` | 实际产出 | 档位 | 文件大小 |
| --- | --- | --- | --- |
| `1024x1024` | **1254x1254** | 1K | ~1.2 MB |
| `2048x2048` | **2048x2048** | 2K | ~1.4 MB |
| `3840x2160` | **3840x2160** | 4K | ~1.7 MB |

### 一个必须知道的前提

尺寸是**通过提示词**传给上游的（chatgpt2api 的 `build_image_prompt` 会写
「输出图片尺寸为 X」），上游**不严格遵守**——所以请求 `1024x1024` 时上游按自己的
`1254x1254` 出图。

**2K/4K 能达标，靠的是 chatgpt2api 的本地放大功能**（`image_upscale_enabled`）：

```text
image_upscale_enabled = false（默认） → 请求 2048x2048，实际只出 1254x1254  ❌
image_upscale_enabled = true         → 请求 2048x2048，实际出 2048x2048     ✅
```

**所以 >1K 前必须先在服务端打开这个开关**（见第四节）。另外要说清楚：它是
**Lanczos 本地放大**，不是上游重绘——细节不会凭空增加，只是把像素插值放大。

### 完整尺寸档位（13 个，对齐控制台预设）

```text
auto
1K: 1024x1024  1024x1536  1536x1024  1024x1365  1365x1024  1088x1920  1920x1088
2K: 2048x2048  2560x1440  1440x2560
4K: 3840x2160  2160x3840
```

---

## 二、为什么需要这个插件（排查结论）

| 检查项 | 结果 |
| --- | --- |
| DSH 官方包（约 250 个） | **没有任何生图工具包**（只有 bash/fs/pwsh/web/skill/subagent 等） |
| `@deepseek-ai/dsh-llm-pi-ai` 适配器契约 | 只有 `stream(options)`，没有生图方法 |
| 全量搜索 `generateImages` / `createImagesProvider` | 在 `@deepseek-ai` 全部包里**零命中** |
| 底层 `@earendil-works/pi-ai` | 实现了 `openrouter-images`，但 **DSH 从未把它接进来** |

结论：DSH 侧**没有生图入口、没有工具、没有 provider 注册点**，只能靠 MCP 把外部生图能力接进来。

> **重要区分**：这里说的是「**DSH 本地**没有生图工具」。
> 如果你的 DSH 已经把 chatgpt2api 配成 provider（`cordis.patch.yml` 里的 `llm-pi-ai`），
> 那么**模型侧**的生图是另一条路——由客户端决定是否给请求挂 `image_generation` 工具。
> 两条路互不冲突，这个 MCP 补的是「本地工具」这一侧。

---

## 三、工具

| 工具名（模型看到的） | 作用 |
| --- | --- |
| `mcp__imagegen__generate_image` | **文生图**：按提示词画一张新图，落盘到 `<output_dir>/generated-images/`，返回绝对路径 |
| `mcp__imagegen__edit_image` | **图生图**：拿你给的图片当参考，按提示词改图 / 换背景 / 换风格 |
| `mcp__imagegen__list_image_models` | 列出可用图片模型、默认模型、落盘目录、两个接口 |

### `generate_image` 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | ✅ | 图片描述，越具体越好 |
| `resolution` | | **清晰度档位**：`1k` / `2k` / `4k`。**只对方形真正生效** |
| `ratio` | | **画面比例**：`1:1` / `16:9` / `9:16` / `4:3` / `3:4` / `3:2` / `2:3`（默认 `1:1`） |
| `size` | | 精确像素尺寸，13 档之一，优先级最高（**非方形会变形，见下**） |
| `n` | | 1–4 张，默认 1 |
| `model` | | `gpt-image-2` / `gpt-image-2.5` / `-flare` / `-sunburst`，默认 `gpt-image-2.5`（**见下方真相**） |
| `quality` | | `auto` / `low` / `medium` / `high`（**基本无效**，见下方真相） |
| `output_dir` | | **建议总是传**当前会话工作区绝对路径 |

> **为什么必须传 `output_dir`**：DSH 会清洗 stdio 子进程的环境（`DSH_*` 一律丢弃），
> MCP 子进程**拿不到会话工作区**，而 `present` 和 markdown 渲染只认工作区内的路径。
> 配置里的 `IMAGEGEN_OUTPUT_DIR` 只是兜底默认值。

### 比例怎么用（重要：避免变形）

上游**不遵守尺寸提示**——实测请求 `1024x1024` 得到 `1254x1254`，说明它按自己的默认**方形**出图。
而 chatgpt2api 的本地放大用 `fit:'fill'`（Sharp）/ 直接 `resize()`（Pillow），是**硬拉**不是裁剪。

结果：把方图拉到 16:9，正圆会变成 **1.78:1 的椭圆**（已实测）。所以本插件这样处理：

| 你要的 | 行为 | 结果 |
| --- | --- | --- |
| **方形**（`1:1` 或不传 `ratio`） | 按 `resolution` 下发像素并本地等比放大 | ✅ 真 1K/2K/4K，**不变形** |
| **横版/竖版**（`ratio=16:9` 等） | **不下发像素**，改为把构图要求写进提示词，由上游出图 | ✅ 不变形，分辨率由上游决定 |
| **显式传 `size`** | 照传像素 | ⚠️ 非方形会被硬拉变形（返回里会警告） |

方形档位：`1k`→`1024x1024`，`2k`→`2048x2048`，`4k`→`3840x3840`。
（官方 13 档里没有方形 4K，`3840x2160` 是 16:9，拿它当方形会立刻变形。）

**所以想要横版海报**：直接说「16:9 横版」，工具会把「横向宽幅构图」写进提示词，
让 ChatGPT 自己按横构图生成，**不要**自己去传 `2560x1440`。

### `edit_image`（图生图）参数

在你给的图片上按提示词生成新图。参数与 `generate_image` 基本一致，多了参考图：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | ✅ | **要改成什么样**（不是「这是什么」）；要保留的部分也写清楚 |
| `image` | ✅\* | 参考图：工作区里的**绝对路径**；也接受 `http(s)` URL 或 `data:` URL |
| `images` | ✅\* | 多张参考图（数组，≤16 张），第一张通常是被改的主体 |
| `resolution` / `ratio` / `size` | | 规则与 `generate_image` **完全一致**（含防变形那套） |
| `n` | | 1–4 张，默认 1 |
| `model` | | 四个名字等价，默认 `gpt-image-2.5` |
| `quality` | | 只写进提示词，基本无效 |
| `output_dir` | | **建议总是传**当前会话工作区绝对路径 |

\* `image` 与 `images` 至少给一个；都不给时工具会直接报错并提示改用 `generate_image`。

落盘文件名带 `edited-` 前缀，和文生图的 `image-` 区分开。

**你只要说人话，模型会自己填参数：**

| 你说的 | 它实际会调 |
| --- | --- |
| 「把这张图改成夜晚」 | `edit_image(prompt="改成夜晚…", image="<你的图>")` |
| 「参考这张画个 16:9 横版海报」 | `edit_image(prompt="…", image="…", ratio="16:9")` |
| 「把 B 的画风套到 A 上」 | `edit_image(prompt="…", images=["A", "B"])` |
| 「去掉背景里的路人」 | `edit_image(prompt="去掉背景里的路人，其余保持不变", image="…")` |

**和 `generate_image` 的本质区别**：`edit_image` 会把参考图**真的上传**给上游
（服务端 `_upload_image` → `file-service://` 引用塞进 `multimodal_text`），
所以原图内容模型是真看得见的，不是「照着提示词重新画一张」。

**它明显更慢（实测一次成功调用）**

| 阶段 | 耗时 |
| --- | --- |
| 上传参考图 | ~15 s |
| sentinel 握手 | ~32 s |
| 生成（SSE 流） | ~83 s |
| 回传图片 | ~20 s（慢的时候会到 120 s 超时） |
| **总计** | **150 s**（失败那次 337 s 后 504） |

所以 `IMAGEGEN_TIMEOUT_MS` 别调小（默认 600000）。

### 传输：固定走 SSE（这也是它能在 Cloudflare 后面用的原因）

本工具**总是**在请求体里带 `stream: true`，然后逐帧解析 SSE：

```text
: heartbeat                                        ← 注释帧，保活用，客户端忽略
event: image_generation.completed
data: {"type":"image_generation.completed","b64_json":"iVBORw0KGgo..."}
```

原因是 chatgpt2api 的流式生图**一开始就先发 `: heartbeat` 注释帧**，之后每个上游进度事件
也发一帧；而非流式要等整张图生成完才回响应头。

这直接决定它能不能放在反向代理后面：

| 前置 | 非流式 | 流式（本工具 0.5.0+） |
| --- | --- | --- |
| 本机直连 `127.0.0.1:3000` | 可以 | 可以 |
| Cloudflare 隧道（免费版 100 秒源站超时） | **生成超过 100 秒必 524** | 可以（首字节 < 10 s，之后靠心跳保活） |

实测（同一张 1024x1024 请求，经 `trycloudflare.com` 隧道）：

```text
非流式   TTFB 42.15 s    →  超过 100 s 的生成会被 CF 掐成 524: A timeout occurred
流式     TTFB  0.9~6.7 s →  48~82 s 的三次生成全部 200
```

`524` 是 **Cloudflare 自己的错误码**（源站 100 秒内没有开始响应），不是 chatgpt2api 的错误码，
所以之前会出现「本地好好的、发给朋友就调不通」。

### 三个必须知道的真相

**1. 四个模型名现在走同一条上游路由（这一条 2026-10 变了）**

`openai_backend_api.py` 的 `_image_model_slug()` 现在只剩两个分支：

```python
if base_model == CODEX_IMAGE_MODEL:  return base_model   # ← 仅 codex 专属，Free 账号用不了
return "auto"                                            # ← 其余四个全部落这里
```

原来 `gpt-image-2 → gpt-5-3` 那条独立路由**已经失效**：`gpt-5-3` 在 2026-10 从账号模型清单里下线，
而上游对不认识的 slug 会先回一个 `conduit_token: null` 的 prepare，紧接着把
`/backend-api/f/conversation` 变成**伪装成 404 的握手拒绝**（`{"detail":"Model not found"}`）——
表现为「生图一直 404，但账号和额度都正常」。所以四个名字现在**完全等价**，都走 `auto`。

**2. `quality` 只写进提示词，上游不遵守**

`conversation.build_image_prompt()` 把尺寸和质量拼成文本塞进 prompt：

```python
hints.append(f"输出图片尺寸为 {size}。")
hints.append(f"输出图片质量为 {quality}。")
```

上游请求体里**没有** `size`/`quality` 字段。实测 `quality=low` 与 `high` 出图分辨率完全一致。

**3. `size` 也靠提示词，>1K 靠本地放大兜底**

上游对 `1024x1024` 实际给 `1254x1254`。方形 `2048x2048` / `3840x3840` 能达标，是因为
chatgpt2api 开了 `image_upscale_enabled` 后在本地做 **Lanczos 等比放大**——是插值放大，不是上游重绘，
细节不会真的增加。

### 怎么让模型一定按你说的选

模型**可以**传这些参数，但调用工具时习惯省略可选参数——这就是「它总用默认
`gpt-image-2.5`」的原因。要让它按你的意思选，**在提问里把要求说清楚**：

```text
帮我画一只戴墨镜的橘猫，扁平插画风格，2K，方形，来三张
帮我画一张赛博朋克城市夜景，16:9 横版
```

对应到工具调用：

| 你的说法 | 模型应传的参数 |
| --- | --- |
| 「2K」 | `resolution: "2k"`（方形才真正生效） |
| 「16:9」/「宽屏」/「横版」 | `ratio: "16:9"` |
| 「竖版」/「手机壁纸」 | `ratio: "9:16"` |
| 「方形」 | `ratio: "1:1"` |
| 「三张」/「多来几张」 | `n: 3` |
| 「2560x1440」 | `size: "2560x1440"`（会变形，慎用） |
| 「用 gpt-image-2」 | `model: "gpt-image-2"` |

工具的 description 里已经写明「用户说了尺寸/清晰度/张数/比例时必须传进来」，
所以只要你说清楚，模型就会照传。

---

## 四、服务端前置条件

### 1. chatgpt2api 在跑，且号池有可用账号

### 2. 要方形 2K/4K 就必须打开放大开关

（只影响方形：非方形走提示词，不经过本地放大。）

```powershell
$k = (Get-Content 'D:\Download games\chatgpt2api\chatgpt2api\config.json' | ConvertFrom-Json).'auth-key'
$h = @{ Authorization = "Bearer $k"; 'Content-Type' = 'application/json' }

# 注意：必须带 revision（乐观锁），字段是扁平的，不要包在 settings 里
$s = Invoke-RestMethod 'http://127.0.0.1:3000/api/settings' -Headers $h
Invoke-RestMethod 'http://127.0.0.1:3000/api/settings' -Method Patch -Headers $h `
  -Body (@{ revision = $s.revision; image_upscale_enabled = $true } | ConvertTo-Json -Compress)

# 验证
(Invoke-RestMethod 'http://127.0.0.1:3000/api/model-catalog' -Headers $h).capabilities
# 期望 image_upscale = True
```

---

## 五、安装（Windows / PowerShell 7）

```powershell
# 1. 解压后进目录
cd <解压出来的>\imagegen-mcp

# 2a. 本机用（chatgpt2api 就跑在这台机器上）
pwsh -File .\install.ps1

# 2b. 给朋友用（chatgpt2api 在别人的机器/公网隧道后面）——把地址和密钥一起喂进去，
#     省得人工去改 YAML 里那两行
pwsh -File .\install.ps1 `
    -BaseUrl https://xxxx.trycloudflare.com/v1 `
    -ApiKey  sk-xxxxxxxx `
    -OutputDir "D:\work"
```

`install.ps1` 参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-TargetDir` | `$env:USERPROFILE\.dsh\mcp` | DSH 的 MCP 目录 |
| `-NodePath` | `E:/node/node.exe` | 你的 node 路径 |
| `-BaseUrl` | `http://127.0.0.1:3000/v1` | 指向公网隧道时填 `https://xxx.trycloudflare.com/v1`；漏了 `/v1` 脚本会自动补 |
| `-ApiKey` | 占位符 | 填 **user** 密钥（管理员密钥别外发） |
| `-OutputDir` | 占位符 | 生成图片的落盘目录 |
| `-SkipDeps` | | 跳过 `npm install`（依赖已就绪时用） |

### 手动安装（等价）

```powershell
# 复制到 DSH 的 MCP 目录
robocopy . "$env:USERPROFILE\.dsh\mcp\imagegen-mcp" /E /XD node_modules

# 装依赖
cd "$env:USERPROFILE\.dsh\mcp\imagegen-mcp"
npm install --ignore-scripts
```

---

## 六、挂载到 DSH

在 `~/.dsh/profiles/<你的 profile>/cordis.patch.yml` **追加**一段（注意是 YAML 数组的顶层条目）：

```yaml
- id: mcp-imagegen
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: imagegen
    transport: stdio
    command: E:/node/node.exe
    args:
      - C:/Users/<你>/.dsh/mcp/imagegen-mcp/src/index.mjs
    cwd: C:/Users/<你>/.dsh/mcp/imagegen-mcp
    env:
      # stdio 子进程的环境会被 DSH 清洗（KEY/TOKEN/SECRET 一律丢弃），
      # 所以密钥必须写在这一行自己的 env: 里，不能指望进程环境。
      CHATGPT2API_API_KEY: <你的 chatgpt2api 密钥>
      CHATGPT2API_BASE_URL: http://127.0.0.1:3000/v1
      IMAGEGEN_DEFAULT_MODEL: gpt-image-2.5
      IMAGEGEN_TIMEOUT_MS: "600000"
      # 图片默认落盘位置；模型也可以用 output_dir 参数按会话覆盖。
      # 必须放在会话工作区内，present 与 markdown 渲染才认得。
      IMAGEGEN_OUTPUT_DIR: D:/你的/会话工作区
    toolCallTimeoutMs: 660000
```

**改完必须重启 DSH**，否则不加载。

### 验证挂载成功

重启后在对话里说「列出你的生图工具」，或直接：

```text
帮我画一只戴墨镜的橘猫，2K，扁平插画风格
```

模型应该调用 `mcp__imagegen__generate_image`，并返回落盘路径。

图生图：把一张图放进工作区，然后说「把 `<路径>` 这张图改成夜晚场景」，
模型应该调用 `mcp__imagegen__edit_image`。注意它比文生图慢得多（实测 150 s 起），
而且会受 chatgpt2api 的**图片任务硬 deadline** 限制（见 §九）。

---

## 七、环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHATGPT2API_API_KEY` | — | **必需**，写在 cordis.patch.yml 的 `env:` 块 |
| `CHATGPT2API_BASE_URL` | `http://127.0.0.1:3000/v1` | 也可指向公网隧道地址（如 `https://xxx.trycloudflare.com/v1`）。走 SSE，所以 Cloudflare 的 100 秒源站超时不会 524 |
| `IMAGEGEN_DEFAULT_MODEL` | `gpt-image-2.5` | 默认图片模型 |
| `IMAGEGEN_OUTPUT_DIR` | 子进程 cwd | 落盘根目录，图片写到其下 `generated-images/`（若该目录本身即以 `generated-images` 结尾，则直接写入、不重复套层） |
| `IMAGEGEN_TIMEOUT_MS` | `600000` | 单次调用超时（毫秒）。**图生图要 2~6 分钟，别调小** |

---

## 八、实测记录

```text
MCP 握手          initialize + tools/list 正常，3 个工具，13 个尺寸档位
1K                请求 1024x1024 → 产出 1254x1254（1254 KB）  ✅
2K                请求 2048x2048 → 产出 2048x2048（1409 KB）  ✅
4K                请求 3840x2160 → 产出 3840x2160（1705 KB）  ✅
内容校验          图片内容与提示词一致（戴墨镜的橘猫、扁平风格、纯色背景）
落盘位置          <output_dir>\generated-images\
```

### 参数映射验证（离线，用回显服务器捕获实际 payload，不消耗额度）

方案 A 行为：

```text
resolution=2k + ratio=1:1    → size=2048x2048（下发像素）        ✅
resolution=4k + ratio=1:1    → size=3840x3840（下发像素）        ✅
resolution=2k（默认方形）     → size=2048x2048                    ✅
resolution=2k + ratio=16:9   → 不下发 size，prompt 追加「横向宽幅构图（16:9 全景）」  ✅
resolution=4k + ratio=9:16   → 不下发 size，prompt 追加「竖向构图（9:16 竖屏）」      ✅
只给 ratio=16:9              → 不下发 size，走构图提示词          ✅
size=2560x1440（显式）        → size=2560x1440 + 变形警告         ⚠️ 按调用方要求照传
size=1024x1024（显式方形）    → size=1024x1024，无警告            ✅
什么都不传                    → 不发 size，上游按自己默认出图    ✅
n=3                          → n=3                                ✅
model=gpt-image-2            → model=gpt-image-2（上游统一 auto）   ✅
```

### 变形验证（本地计算，不调用上游）

造一张 **1254×1254 的正圆**，走 chatgpt2api 的放大路径，量圆的**绝对**宽高比
（不能量「占整图比例」——那在拉伸下是不变量，会漏判）：

```text
目标 1024x1024  → 1254x1254  圆包围盒 628x628    宽高比 1.000  不变形 ✅
目标 2048x2048  → 2048x2048  圆包围盒 1026x1026  宽高比 1.000  不变形 ✅
目标 3840x3840  → 3840x3840  圆包围盒 1924x1924  宽高比 1.000  不变形 ✅
目标 2560x1440  → 2560x1440  圆包围盒 1282x722   宽高比 1.776  圆被拉成椭圆 ❌
目标 3840x2160  → 3840x2160  圆包围盒 1924x1082  宽高比 1.778  圆被拉成椭圆 ❌
目标 1088x1920  → 1088x1920  圆包围盒 546x962    宽高比 0.568  圆被拉成椭圆 ❌
目标 1440x2560  → 1440x2560  圆包围盒 722x1282   宽高比 0.563  圆被拉成椭圆 ❌
```

结论：方形等比放大安全；非方形硬拉必然变形——这就是方案 A 对非方形改走提示词的原因。

### 模型等价性验证（各跑一次，同尺寸 1024x1024）

```text
gpt-image-2             → 1254x1254   47.2s
gpt-image-2.5           → 1254x1254   42.2s
gpt-image-2.5-flare     → 1254x1254   38.9s
gpt-image-2.5-sunburst  → 1254x1254   43.0s
结论：四个名字完全等价。2026-10 之前 `gpt-image-2` 走独立 slug（`gpt-5-3`），
该 slug 从账号模型清单下线后，服务端已把四个名字统一回退到 `auto`。
```

### 数量与质量验证

```text
n=1 → 1 张；n=2 → 2 张；n=3 → 3 张                       ✅ 数量有效
quality=low  → 1254x1254；quality=high → 1254x1254      ⚠️ 无可观察差异
```

---

### 图生图验证（2026-10-17，真实调用，非离线）

```text
路径 A  直接 POST /v1/images/edits（640x640 PNG，3.8 KB 参考图）
        88.9 s → HTTP 200，2,409,794 B，1254x1254
        usage  input_tokens=673（image_tokens=648），output_tokens=1650（image_tokens=1650）

路径 B  真实 MCP stdio JSON-RPC → tools/call edit_image（505,920 B 参考图）
        54.0 s → isError=false，2,155.7 KB，1254x1254
        落盘  <output_dir>\generated-images\edited-20261017-134648-1.png
```

内容校验：路径 A 的白底红圆图 → 背景换成星空银河、红圆与绿矩形原样保留；
路径 B 的仙人掌陶盆图 → 仙人掌与陶盆保留、背景换成月夜湖景。

更早一次直接调用 150.3 s 成功，另两次 215 s / 225 s 被服务端硬 deadline（当时 170 s）
打断 → 503 `task_interrupted`。**把 deadline 调到 360 s 后连续两次都在 90 s 内通过**（见 §九）。

MCP 层验证：`tools/list` 返回 3 个工具（`generate_image` / `edit_image` / `list_image_models`），
`edit_image` 能把本地路径读成 `data:` URL 并正确打到 `/images/edits`。

## 九、已知限制

- 单张约 35–60 秒；`toolCallTimeoutMs` 已放宽到 11 分钟。
- 上游偶尔会改写提示词（`revised_prompt` 会一并返回）。
- **方形 >1K 依赖服务端 `image_upscale_enabled=true`**，且是本地放大不是重绘。
- **非方形不给精确像素**：改走提示词，实际分辨率由上游决定。想要精确的非方形像素
  只能显式传 `size`，但那会被硬拉变形。
- **`quality` 参数基本无效**：只被拼进提示词，上游请求体里没有对应字段。
- **四个模型名现在完全等价**（上游同一 `auto` 路由）；原来 `gpt-image-2 → gpt-5-3`
  那条独立 slug 已于 2026-10 从账号模型清单下线，服务端已改为统一回退 `auto`。
- 图片模型白名单与 chatgpt2api 的 `WEB_IMAGE_MODELS` 一致；
  **对话模型（`gpt-6`）不能用于生图**，传了会被 chatgpt2api 拒绝。
- 依赖 chatgpt2api 在跑且号池有可用账号。
- 密钥以明文写在 `cordis.patch.yml`（DSH 会清洗子进程环境，只能这样传）。
  建议单独签一个 user 密钥专用于此，而不是用 admin 密钥。
- **模型可能省略可选参数**：工具已暴露全部参数，但模型调用时习惯不传。
  要确保按你的意思出图，请在提问里明确写出清晰度/比例/张数。
- **图生图明显更慢**：实测一次成功调用 150 s（上传参考图 15 s + 握手 32 s + 生成 83 s + 回传 20 s）。
- **图生图偶尔 504**：上游回传生成的图片时会卡住（`curl: (28) Operation timed out after
  120009 milliseconds with 998494 bytes received`），服务端返回 504、工具报错。
  这是上游回传环节的问题，重试即可，**不是协议问题**。
- **参考图上限 30 MB**（工具侧按原图字节卡）：服务端硬上限是 50 MB/张，base64 后还要再膨胀约 1/3，
  所以工具提前卡在 30 MB 并给出可读报错，而不是让服务端丢一个 400。
- **图生图受服务端硬 deadline 制约**：chatgpt2api 的

  `image_request_timeout_secs = image_stream_timeout_secs + image_poll_timeout_secs + 30`
  （`services/config.py:531`），出厂默认 `80 + 60 + 30 = **170 秒**`。

  图生图实测要 150–337 s（上传参考图 + 重新握手 + 生成 + 回传），**一超过 deadline 就被判
  `task_interrupted` → HTTP 503**，`raw_error: image request deadline exceeded before asset storage`。
  实测三次：150 s 成功；215 s、225 s 被 503 打断。

  **本机已调到 360 秒**（`180 + 150 + 30`）。改法注意：`SettingsPatch` 是**扁平**字段、
  `revision` 是**字符串**，写成嵌套 `{"settings": {...}}` 会得到 422：

  ```powershell
  $k = "<chatgpt2api 密钥>"
  $h = @{ Authorization = "Bearer $k" }
  $s = Invoke-RestMethod "http://127.0.0.1:3000/api/settings" -Headers $h
  Invoke-RestMethod "http://127.0.0.1:3000/api/settings" -Method Patch -Headers $h -ContentType 'application/json' `
    -Body (@{ revision = $s.revision; image_stream_timeout_secs = 180; image_poll_timeout_secs = 150 } | ConvertTo-Json)
  ```

  `restart_required=false`，立即生效。还原成 170 s 就把两个值改回 80 / 60。
- **并发/同秒落盘不再互相覆盖**（0.5.2 修复）：旧版文件名只到秒级（`前缀-时间戳-序号`），
  两次调用落在同一秒会算出**完全相同**的路径，而 `writeFile` 默认是覆盖模式 ——
  后一张静默盖掉前一张，图凭空消失且全程没有报错。现在文件名带 8 位随机量并用
  `wx` 独占创建（同名就重试），200 路并发写同一目录实测 200 个文件全部保留、内容互不串
  （离线回归：`.tmp\imagegen-concurrency-test.mjs`，13 项全 PASS）。
- **`output_dir` 语义**（0.5.2）：传工作区根目录时图片写到其下 `generated-images\`；
  如果传的目录本身就以 `generated-images` 结尾，就**直接写进去、不再套一层**
  （旧版会生成 `generated-images\generated-images\`，图片"找不到"就是这个原因）。
- **后缀按真实字节判断**（0.5.2）：`b64_json` 分支原来硬编码 `.png`，但 `response_format`
  并不保证格式；现在嗅探 PNG / JPEG / WEBP / GIF / BMP 的文件头魔数再定后缀。
- **图生图会自检「原图回传」**（0.5.2）：按 sha256 把输出和参考图逐字节比对，
  命中就在返回里给出「与参考图完全相同、建议丢弃重试」的警告。
- **改动 `cordis.patch.yml` 后必须重启 DSH** 才会出现 `mcp__imagegen__*` 工具。
