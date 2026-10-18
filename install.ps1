#Requires -Version 5.1
<#
.SYNOPSIS
    imagegen-mcp 安装脚本：拷贝文件、装依赖、自动写入 DSH 的 MCP 配置。

.DESCRIPTION
    所有路径按当前机器自动探测，不需要手改 YAML：
      1. 找 Node（PATH 与常见安装位置）
      2. 找 DSH 主目录（DSH_HOME 或 ~/.dsh）
      3. 找 profile（profiles 下有 cordis.patch.yml 的那个）
      4. 拷贝到 DSH_HOME/mcp/imagegen-mcp
      5. npm install
      6. 写入或替换 cordis.patch.yml 里的 mcp-imagegen 配置块

.PARAMETER ApiKey
    chatgpt2api 的用户密钥。不填则保留占位符，装完自己补。

.PARAMETER BaseUrl
    chatgpt2api 的 /v1 地址。漏了 /v1 会自动补上。

.EXAMPLE
    ./install.ps1 -ApiKey sk-xxxx

.EXAMPLE
    ./install.ps1 -ApiKey sk-xxxx -BaseUrl https://xxx.trycloudflare.com/v1 -Profile web

.EXAMPLE
    ./install.ps1 -ApiKey sk-xxxx -SkipDeps
#>
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$Profile = '',
    [string]$TargetDir = '',
    [string]$NodePath = '',
    [string]$BaseUrl = 'http://127.0.0.1:3000/v1',
    [string]$ApiKey = '',
    [string]$OutputDir = '',
    [string]$Model = 'gpt-image-2.5',
    [int]$TimeoutMs = 600000,
    [switch]$SkipDeps,
    [switch]$SkipConfig
)

$ErrorActionPreference = 'Stop'
$script:here = $PSScriptRoot
$script:blockStart = '# >>> imagegen-mcp (managed by install.ps1)'
$script:blockEnd = '# <<< imagegen-mcp'

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

function Resolve-Profile([string]$Root) {
    $profilesDir = Join-Path $Root 'profiles'
    if (-not (Test-Path $profilesDir)) { return $null }

    if ($Profile) {
        $candidate = Join-Path $profilesDir $Profile
        if (Test-Path $candidate) { return $Profile }
        return $null
    }

    $withPatch = @(Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'cordis.patch.yml') })

    if ($withPatch.Count -eq 0) { return $null }
    if ($withPatch.Count -eq 1) { return $withPatch[0].Name }

    $web = $withPatch | Where-Object { $_.Name -eq 'web' } | Select-Object -First 1
    if ($web) { return $web.Name }
    return $withPatch[0].Name
}

function Build-ConfigBlock {
    param(
        [string]$NodeFile,
        [string]$EntryFile,
        [string]$WorkDir,
        [string]$Url,
        [string]$Key
    )

    $node = $NodeFile.Replace('\', '/')
    $entry = $EntryFile.Replace('\', '/')
    $dir = $WorkDir.Replace('\', '/')
    $keyValue = if ($Key) { $Key } else { '<填入 chatgpt2api 用户密钥>' }

    # 注意：PowerShell 里逗号比 + 绑得紧，数组元素里的字符串拼接必须自己加括号，
    # 否则 'key: ' + $value 会被拆成两个元素，写出来的 YAML 直接解析失败。
    $lines = @(
        $script:blockStart,
        '- insert:',
        '    - id: mcp-imagegen',
        '      name: "@deepseek-ai/dsh-mcp-client"',
        '      config:',
        '        serverName: imagegen',
        '        transport: stdio',
        ('        command: ' + $node),
        '        args:',
        ('          - ' + $entry),
        ('        cwd: ' + $dir),
        '        env:',
        ('          CHATGPT2API_API_KEY: ' + (ConvertTo-YamlValue $keyValue)),
        ('          CHATGPT2API_BASE_URL: ' + (ConvertTo-YamlValue $Url)),
        ('          IMAGEGEN_DEFAULT_MODEL: ' + (ConvertTo-YamlValue $Model)),
        ('          IMAGEGEN_TIMEOUT_MS: "' + $TimeoutMs + '"')
    )

    if ($OutputDir) {
        $lines += ('          IMAGEGEN_OUTPUT_DIR: ' + (ConvertTo-YamlValue $OutputDir.Replace('\', '/')))
    }

    $lines += @(
        ('        toolCallTimeoutMs: ' + ($TimeoutMs + 60000)),
        $script:blockEnd
    )
    return $lines
}

# YAML 标量一律双引号包裹并转义内部引号，密钥里出现 # : { } 也不会破坏解析。
function ConvertTo-YamlValue([string]$Value) {
    $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
    return '"' + $escaped + '"'
}

function Update-PatchFile {
    param([string]$Path, [string[]]$Block)

    $existing = @()
    if (Test-Path $Path) { $existing = @(Get-Content -Path $Path -Encoding UTF8) }

    $startAt = -1
    $endAt = -1
    for ($i = 0; $i -lt $existing.Count; $i++) {
        $trimmed = $existing[$i].Trim()
        if ($trimmed -eq $script:blockStart) { $startAt = $i }
        elseif ($trimmed -eq $script:blockEnd) { $endAt = $i }
    }

    if ($startAt -ge 0 -and $endAt -gt $startAt) {
        $head = @()
        if ($startAt -gt 0) { $head = $existing[0..($startAt - 1)] }
        $tail = @()
        if ($endAt -lt ($existing.Count - 1)) { $tail = $existing[($endAt + 1)..($existing.Count - 1)] }
        $merged = @($head) + @($Block) + @($tail)
        $action = 'replaced'
    }
    else {
        $merged = @($existing)
        if ($merged.Count -gt 0 -and $merged[$merged.Count - 1].Trim() -ne '') { $merged += '' }
        $merged += @($Block)
        $action = 'appended'
    }

    $content = ($merged -join [Environment]::NewLine) + [Environment]::NewLine
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $content, $encoding)
    return $action
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

$profileName = Resolve-Profile $homeDir
if ($profileName) { Write-Detail ('profile ' + $profileName) }
else { Write-Note 'no profile with cordis.patch.yml found; config write will be skipped' }

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
elseif (-not $profileName) {
    Write-Step 'skip config write (profile not found)'
}
else {
    Write-Step 'write DSH config'

    $url = $BaseUrl.TrimEnd('/')
    if ($url -notmatch '/v1$') {
        $url = $url + '/v1'
        Write-Detail ('normalized to ' + $url)
    }

    $patchPath = Join-Path (Join-Path (Join-Path $homeDir 'profiles') $profileName) 'cordis.patch.yml'
    $entryFile = Join-Path (Join-Path $target 'src') 'index.mjs'
    $block = Build-ConfigBlock -NodeFile $nodeFile -EntryFile $entryFile -WorkDir $target -Url $url -Key $ApiKey
    $action = Update-PatchFile -Path $patchPath -Block $block

    Write-Ok ($action + ' ' + $patchPath)
    if (-not $ApiKey) { Write-Note 'no -ApiKey given; placeholder left in YAML, fill it before restarting DSH' }
}

Write-Host ''
Write-Step 'done'
Write-Detail 'restart DSH, then tools create_images / list_models are available'
Write-Detail ('default output: ' + (Join-Path $target 'output') + ' (use folder to categorize)')
Write-Detail 'for 2K/4K enable image_upscale_enabled in chatgpt2api'

# robocopy 成功时也会返回 1，脚本结束前显式清零，避免被当成失败。
exit 0
