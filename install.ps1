# imagegen-mcp 一键安装（Windows / PowerShell 7）
#
# 本机用（chatgpt2api 就跑在这台机器上）：
#   .\install.ps1
#
# 给朋友用（chatgpt2api 在别人机器/公网隧道后面）：
#   .\install.ps1 -BaseUrl https://xxxx.trycloudflare.com/v1 -ApiKey sk-xxxx -OutputDir "D:\work"
#
# 参数说明：
#   -BaseUrl     填到 cordis.patch.yml 里的 CHATGPT2API_BASE_URL。指向公网隧道时必须带 /v1。
#   -ApiKey      chatgpt2api 的 **user** 密钥（不是管理员密钥，管理员密钥别外发）。
#   -OutputDir   生成的图片落在哪；留空则 YAML 里保留占位符让你自己填。
[CmdletBinding()]
param(
    [string]$TargetDir = "$env:USERPROFILE\.dsh\mcp",
    [string]$NodePath  = 'E:/node/node.exe',
    [string]$BaseUrl   = 'http://127.0.0.1:3000/v1',
    [string]$ApiKey    = '<你的 chatgpt2api 密钥>',
    [string]$OutputDir = '',
    [switch]$SkipDeps
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dest = Join-Path $TargetDir 'imagegen-mcp'
Write-Host "==> 安装到 $dest"
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
robocopy $here $dest /E /XD node_modules generated-images /NFL /NDL /NJH /NJS /NP | Out-Null
if (-not $SkipDeps) {
    $npm = Join-Path (Split-Path $NodePath) 'npm.cmd'
    if (Test-Path $npm) {
        Write-Host '==> 安装依赖'
        Push-Location $dest; & $npm install --ignore-scripts; Pop-Location
    } else {
        Write-Warning "未找到 npm（$npm），请手动: cd `"$dest`"; npm install --ignore-scripts"
    }
}
$destPosix = $dest.Replace('\','/')

# 公网隧道地址如果漏了 /v1，这里补上——chatgpt2api 的 OpenAI 兼容前缀就是 /v1，
# 少了它会 404，而且报错长得像"模型不存在"，很难查。
$baseUrlOut = $BaseUrl.TrimEnd('/')
if ($baseUrlOut -notmatch '/v1$') {
    $baseUrlOut = "$baseUrlOut/v1"
    Write-Host "==> 已自动补成 $baseUrlOut" -ForegroundColor DarkGray
}
$outputOut = if ($OutputDir) { $OutputDir.Replace('\','/') } else { '<会话工作区绝对路径>' }

Write-Host ''
Write-Host '==> 在 ~/.dsh/profiles/<profile>/cordis.patch.yml 追加下面这段，然后重启 DSH' -ForegroundColor Cyan
Write-Host @"

- id: mcp-imagegen
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: imagegen
    transport: stdio
    command: $NodePath
    args:
      - $destPosix/src/index.mjs
    cwd: $destPosix
    env:
      CHATGPT2API_API_KEY: $ApiKey
      CHATGPT2API_BASE_URL: $baseUrlOut
      IMAGEGEN_DEFAULT_MODEL: gpt-image-2.5
      IMAGEGEN_TIMEOUT_MS: "600000"
      IMAGEGEN_OUTPUT_DIR: $outputOut
    toolCallTimeoutMs: 660000

"@
Write-Host '==> 这个 MCP 的请求固定带 stream:true 走 SSE，' -ForegroundColor Green
Write-Host '    所以经 Cloudflare 隧道调生图不会被 100 秒源站超时掐成 524。' -ForegroundColor Green
Write-Host '==> 要 2K/4K 还需在 chatgpt2api 打开 image_upscale_enabled（见 README 第四节）' -ForegroundColor Yellow
