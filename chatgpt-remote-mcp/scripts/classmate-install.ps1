# 在【你自己的 Windows】上跑（PowerShell，不需要管理员）。
# 做的事：装 DevSpace → 写配置 → 配 SSH → 注册两个「登录时自动启动 + 崩了自动重来」的计划任务
#
#   .\classmate-install.ps1 -McpUser mcp-xxx -McpPort 17681 -McpFqdn mcp-xxx.yourdomain.cn
#
# Windows 没有 launchd。不注册计划任务的话，重启后一切都不会自己起来。

param(
    [Parameter(Mandatory=$true)][string]$McpUser,
    [Parameter(Mandatory=$true)][int]   $McpPort,
    [Parameter(Mandatory=$true)][string]$McpFqdn,
    [string]$McpServerIp = "203.0.113.20",
    [string]$KeyPath = ""
)

$ErrorActionPreference = "Stop"
$Home_    = $env:USERPROFILE
$SshDir   = Join-Path $Home_ ".ssh"
$Key      = if ($KeyPath) { $KeyPath } else { Join-Path $SshDir "mcp_relay" }
$DsDir    = Join-Path $Home_ ".devspace"
$LogDir   = Join-Path $DsDir "logs"
$BinDir   = Join-Path $DsDir "bin"
# 允许 ChatGPT / Claude 网页端的 OAuth 回调（DevSpace 默认只放行 chatgpt.com）
$RedirectHosts = "chatgpt.com,claude.ai,claude.com,localhost,127.0.0.1"

Write-Host "==> 1/7 前置检查"
foreach ($c in @("node","npm","ssh")) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
        throw "找不到 $c。node/npm 去 nodejs.org 装（要 >=22.19 <27）；ssh 是 Windows 自带的 OpenSSH 客户端，在「设置 → 应用 → 可选功能」里加。"
    }
}
node -v
if (-not (Test-Path $Key)) {
    throw "找不到 $Key —— 第 0 步应先生成密钥并把 .pub 发给管理员：`n  ssh-keygen -t ed25519 -f `"$Key`" -N `"`" -C `"$env:USERNAME@$env:COMPUTERNAME-mcp`""
}

Write-Host "==> 2/7 收紧私钥权限（OpenSSH 会拒绝其他人可读的私钥）"
icacls $Key /inheritance:r /grant:r "${env:USERNAME}:(R)" | Out-Null

Write-Host "==> 3/7 安装 DevSpace"
npm install -g @waishnav/devspace --no-fund --no-audit | Select-Object -Last 2
$NpmRoot = (npm root -g).Trim()
$DsCli   = Join-Path $NpmRoot "@waishnav\devspace\dist\cli.js"
if (-not (Test-Path $DsCli)) { throw "装完了但找不到 $DsCli" }

Write-Host "==> 4/7 写 DevSpace 配置"
New-Item -ItemType Directory -Force -Path $DsDir,$LogDir,$BinDir | Out-Null
# 🔴 必须写不带 BOM 的 UTF-8。PowerShell 5.1 的 `Set-Content -Encoding utf8` 会加 BOM，
# 而 Node 的 readFileSync(...,"utf8") 不剥 BOM，JSON.parse 会当场抛异常、DevSpace 起不来。
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Utf8($Path, $Text) { [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom) }

Write-Utf8 (Join-Path $DsDir "config.json") (@{
    host          = "127.0.0.1"
    port          = 7676
    allowedRoots  = @($Home_)      # 想放开整台机器就改成 @("C:\")
    publicBaseUrl = "https://$McpFqdn"
} | ConvertTo-Json)

$AuthPath = Join-Path $DsDir "auth.json"
if (Test-Path $AuthPath) {
    $Owner = (Get-Content $AuthPath -Raw | ConvertFrom-Json).ownerToken
    Write-Host "    复用已有的 Owner 密码"
} else {
    # 与 DevSpace 的 generateOwnerToken() 一致：32 字节随机数的 base64url
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Owner = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    Write-Utf8 $AuthPath (@{ ownerToken = $Owner } | ConvertTo-Json)
}
Set-Content -Path (Join-Path $DsDir "OWNER_PASSWORD.txt") -Value $Owner -Encoding utf8

Write-Host "==> 5/7 配 SSH"
New-Item -ItemType Directory -Force -Path $SshDir | Out-Null
$SshCfg = Join-Path $SshDir "config"
if (-not (Test-Path $SshCfg)) { New-Item -ItemType File -Path $SshCfg | Out-Null }
if (-not (Select-String -Path $SshCfg -Pattern '^Host mcp-relay$' -Quiet)) {
    Add-Content -Path $SshCfg -Value @"

Host mcp-relay
    HostName $McpServerIp
    User $McpUser
    IdentityFile $Key
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    ServerAliveInterval 20
    ServerAliveCountMax 3
"@
}

Write-Host "==> 6/7 注册计划任务（登录时自启 + 崩了自动重来）"
# Windows 没有 launchd 的 KeepAlive，用无限重试循环自己实现。
# 注意 -R 必须写成 127.0.0.1:端口:... 的完整形式，只写「端口:」会被服务器的
# permitlisten 拒绝，报 remote port forwarding failed。
$TunnelPs1 = Join-Path $BinDir "mcp-tunnel.ps1"
@"
while (`$true) {
    & ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 ``
        -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new ``
        -R 127.0.0.1:${McpPort}:127.0.0.1:7676 mcp-relay 2>&1 |
        Out-File -Append -Encoding utf8 "$LogDir\tunnel.log"
    Start-Sleep -Seconds 15
}
"@ | Set-Content -Path $TunnelPs1 -Encoding utf8

$ServePs1 = Join-Path $BinDir "mcp-devspace.ps1"
@"
`$env:DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS = "$RedirectHosts"
`$env:DEVSPACE_TRUST_PROXY = "true"
while (`$true) {
    & node "$DsCli" serve 2>&1 | Out-File -Append -Encoding utf8 "$LogDir\serve.log"
    Start-Sleep -Seconds 10
}
"@ | Set-Content -Path $ServePs1 -Encoding utf8

$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -StartWhenAvailable
$Trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

foreach ($t in @(@{n="MCP-DevSpace"; s=$ServePs1}, @{n="MCP-Tunnel"; s=$TunnelPs1})) {
    $Action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($t.s)`""
    Register-ScheduledTask -TaskName $t.n -Action $Action -Trigger $Trigger `
        -Settings $Settings -Force | Out-Null
    Start-ScheduledTask -TaskName $t.n
    Write-Host "    已注册并启动：$($t.n)"
}

Write-Host "==> 7/7 验证"
Start-Sleep -Seconds 10
foreach ($u in @(@{n="本地 DevSpace"; u="http://127.0.0.1:7676/mcp"},
                 @{n="公网入口    "; u="https://$McpFqdn/mcp"})) {
    # 🔴 别用 -SkipHttpErrorCheck，那是 PowerShell 7+ 才有的参数；
    # Windows 自带的 5.1 遇到 401 会直接抛异常，必须从 WebException 里把状态码取出来。
    $code = "失败"
    try {
        $code = (Invoke-WebRequest -Uri $u.u -TimeoutSec 15 -UseBasicParsing).StatusCode
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    } catch { }
    Write-Host "    $($u.n): $code"
}
Write-Host "    (401 = 通了；502 = 隧道没起；000/失败 = 本机 DNS 被代理软件劫持，换热点复测)"

Write-Host ""
Write-Host "────────────────────────────────────────"
Write-Host "ChatGPT → 设置 → Apps → Advanced 打开 Developer mode → Connectors → Create"
Write-Host "  MCP server URL : https://$McpFqdn/mcp"
Write-Host "  Authentication : OAuth"
Write-Host ""
Write-Host "Owner 密码：$Owner"
Write-Host "  (也存在 $DsDir\OWNER_PASSWORD.txt)"
Write-Host "────────────────────────────────────────"
Write-Host ""
Write-Host "⚠ 休眠会断隧道。要长期挂着，用管理员 PowerShell 跑："
Write-Host "    powercfg /change standby-timeout-ac 0"
