#Requires -Version 5.1
<#
.SYNOPSIS
    imagegen-mcp 安装脚本：拷贝文件、装依赖，配置交给 src/setup.mjs 写。

.DESCRIPTION
    脚本只做 PowerShell 擅长的事：探环境、拷文件、装依赖。
    DSH 配置与密钥由 Node 侧写（src/setup.mjs）：那里能离线测试，
    也不必在 YAML 字符串拼接上跟 PowerShell 的语法细节缠斗。

    步骤：
      1. 找 Node（PATH 与常见安装位置）
      2. 找 DSH 主目录（DSH_HOME 或 ~/.dsh）
      3. 拷贝到 DSH_HOME/mcp/imagegen-mcp
      4. npm install
      5. node src/setup.mjs —— 写 profile 配置，把密钥放进凭据库

    密钥落点：<DSH_HOME>/.credentials.yaml 的 refs，配置里只留 ${credential:…} 引用。
    旧装法写在 cordis.patch.yml 里的明文密钥会被自动识别并搬过去。

.PARAMETER ApiKey
    chatgpt2api 的用户密钥。写进凭据库；不填则沿用旧配置，再没有就留空等你自己补。

.PARAMETER BaseUrl
    chatgpt2api 的 /v1 地址。不填则沿用上一版配置。漏了 /v1 会自动补上。

.PARAMETER Model
    默认模型。不填则沿用上一版配置。

.PARAMETER TimeoutMs
    单次上游超时。不填则沿用上一版配置。

.PARAMETER OutputDir
    默认落盘目录。不填则沿用上一版配置。

.EXAMPLE
    ./install.ps1 -ApiKey sk-xxxx

.EXAMPLE
    ./install.ps1 -ApiKey sk-xxxx -BaseUrl https://xxx.trycloudflare.com/v1 -Profile web

.EXAMPLE
    ./install.ps1 -SkipDeps
#>
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$Profile = '',
    [string]$TargetDir = '',
    [string]$NodePath = '',
    [string]$BaseUrl = '',
    [string]$ApiKey = '',
    [string]$OutputDir = '',
    [string]$Model = '',
    [int]$TimeoutMs = 0,
    [switch]$SkipDeps,
    [switch]$SkipConfig
)

$ErrorActionPreference = 'Stop'
$script:here = $PSScriptRoot

function Write-Step([string]$Text) { Write-Host ('==> ' + $Text) -ForegroundColor Cyan }
function Write-Detail([string]$Text) { Write-Host ('    ' + $Text) -ForegroundColor DarkGray }
function Write-Ok([string]$Text) { Write-Host ('    OK  ' + $Text) -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host ('    !!  ' + $Text) -ForegroundColor Yellow }

function Resolve-Node {
    if ($NodePath -and (Test-Path $NodePath)) { return (Resolve-Path $NodePath).Path }

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        'C:/Program Files/nodejs/node.exe',
        'C:/Program Files (x86)/nodejs/node.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe'),
        (Join-Path $env:APPDATA 'npm/node.exe'),
        'C:/nodejs/node.exe',
        'D:/nodejs/node.exe',
        'E:/nodejs/node.exe'
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

function Resolve-DshHome {
    if ($DshHome) { return [System.IO.Path]::GetFullPath($DshHome) }
    if ($env:DSH_HOME) { return [System.IO.Path]::GetFullPath($env:DSH_HOME) }
    return (Join-Path $env:USERPROFILE '.dsh')
}

Write-Step 'probe environment'

$nodeFile = Resolve-Node
if (-not $nodeFile) {
    throw 'Node.js not found. Install Node 20+ or pass -NodePath with the absolute path to node.exe.'
}
$nodeVersion = (& $nodeFile --version) -replace '^v', ''
Write-Detail ('node    ' + $nodeFile + ' (' + $nodeVersion + ')')
if ([int]($nodeVersion.Split('.')[0]) -lt 20) { Write-Note ('Node ' + $nodeVersion + ' is below 20') }

$homeDir = Resolve-DshHome
Write-Detail ('dsh     ' + $homeDir)
if (-not (Test-Path $homeDir)) { Write-Note 'DSH home does not exist yet; config will still be written' }

$target = if ($TargetDir) { [System.IO.Path]::GetFullPath($TargetDir) } else { Join-Path $homeDir 'mcp/imagegen-mcp' }
Write-Detail ('install ' + $target)

Write-Step 'copy files'
New-Item -ItemType Directory -Force -Path $target | Out-Null
robocopy $script:here $target /E /XD node_modules output .git .github /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw ('robocopy failed with exit code ' + $LASTEXITCODE) }
Write-Ok $target

if ($SkipDeps) {
    Write-Step 'skip dependencies (-SkipDeps)'
}
else {
    Write-Step 'install dependencies'
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) { $npm = $npmCmd.Source }
    else {
        $guess = Join-Path (Split-Path $nodeFile) 'npm.cmd'
        $npm = if (Test-Path $guess) { $guess } else { $null }
    }

    if ($npm) {
        Push-Location $target
        try {
            & $npm install --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw ('npm install failed with exit code ' + $LASTEXITCODE) }
        }
        finally { Pop-Location }
        Write-Ok 'dependencies installed'
    }
    else {
        Write-Note ('npm not found. Run manually: cd "' + $target + '"; npm install')
    }
}

if ($SkipConfig) {
    Write-Step 'skip config write (-SkipConfig)'
}
else {
    # 只把显式给出的参数往下传，没给的由 setup.mjs 沿用上一版配置，
    # 否则「再装一遍」会把调好的地址、目录悄悄改回默认值。
    $setupArgs = @((Join-Path $target 'src/setup.mjs'), '--dsh-home', $homeDir)
    if ($Profile) { $setupArgs += @('--profile', $Profile) }
    if ($ApiKey) { $setupArgs += @('--api-key', $ApiKey) }
    if ($BaseUrl) { $setupArgs += @('--base-url', $BaseUrl) }
    if ($Model) { $setupArgs += @('--model', $Model) }
    if ($OutputDir) { $setupArgs += @('--output-dir', $OutputDir) }
    if ($TimeoutMs -gt 0) { $setupArgs += @('--timeout-ms', [string]$TimeoutMs) }

    & $nodeFile @setupArgs
    if ($LASTEXITCODE -ne 0) { throw ('config write failed with exit code ' + $LASTEXITCODE) }
}

Write-Host ''
Write-Step 'done'
Write-Detail 'restart DSH, then tools create_images / info are available'
Write-Detail ('key lives in ' + (Join-Path $homeDir '.credentials.yaml') + ', not in the profile config')
Write-Detail 'for 2K/4K enable image_upscale_enabled in chatgpt2api'

# robocopy 成功时也会返回 1，脚本结束前显式清零，避免被当成失败。
exit 0