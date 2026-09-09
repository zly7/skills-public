#!/usr/bin/env bash
# 在【你自己的 Mac】上跑。把管理员发给你的四个值填进去，然后执行。
# 做的事：装 DevSpace → 写配置 → 配 SSH → 建两个 launchd（隧道 + DevSpace，开机自启、断了自愈）
set -euo pipefail

# ── 把管理员给你的值填这里 ──────────────────────────
MCP_USER="${MCP_USER:-}"                          # 例：mcp-alice
MCP_PORT="${MCP_PORT:-}"                          # 例：17677
MCP_FQDN="${MCP_FQDN:-}"                          # 例：mcp-alice.yourdomain.cn
MCP_SERVER_IP="${MCP_SERVER_IP:-203.0.113.20}"
# ────────────────────────────────────────────────

# 允许 ChatGPT / Claude 网页端的 OAuth 回调（DevSpace 默认只放行 chatgpt.com）
REDIRECT_HOSTS="chatgpt.com,claude.ai,claude.com,localhost,127.0.0.1"

for v in MCP_USER MCP_PORT MCP_FQDN MCP_SERVER_IP; do
  [[ -n "${!v}" ]] || { echo "✗ 请先填写 $v" >&2; exit 1; }
done

KEY=~/.ssh/mcp_relay
[[ -f "$KEY" ]] || { echo "✗ 找不到 $KEY —— 第 0 步应先生成密钥并把公钥发给管理员" >&2; exit 1; }

echo "==> 1/6 检查 node（DevSpace 要求 >=22.19 <27）"
command -v node >/dev/null || { echo "✗ 没装 node，先装：brew install node" >&2; exit 1; }
node -v

echo "==> 2/6 安装 DevSpace"
npm install -g @waishnav/devspace --no-fund --no-audit 2>&1 | tail -2
DS_DIR=$(dirname "$(dirname "$(readlink -f "$(command -v devspace)")")")

echo "==> 3/6 写 DevSpace 配置"
node --input-type=module -e "
import { writeDevspaceConfig, writeDevspaceAuth, generateOwnerToken, loadDevspaceFiles }
  from '$DS_DIR/dist/user-config.js';
const f = loadDevspaceFiles();
writeDevspaceConfig({ ...f.config, host:'127.0.0.1', port:7676,
  allowedRoots:[process.env.HOME], publicBaseUrl:'https://$MCP_FQDN' });
const auth = { ownerToken: f.auth.ownerToken ?? generateOwnerToken() };
writeDevspaceAuth(auth);
console.log('OWNER_PASSWORD=' + auth.ownerToken);
" | tee ~/.devspace/OWNER_PASSWORD.txt
chmod 600 ~/.devspace/OWNER_PASSWORD.txt

echo "==> 4/6 配 SSH"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if ! grep -q "^Host mcp-relay$" ~/.ssh/config 2>/dev/null; then
cat >> ~/.ssh/config <<EOF

Host mcp-relay
    HostName $MCP_SERVER_IP
    User $MCP_USER
    IdentityFile $KEY
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    ServerAliveInterval 20
    ServerAliveCountMax 3
EOF
fi
ssh -o ConnectTimeout=20 -o BatchMode=yes mcp-relay true 2>&1 | head -2 || true
echo "    (报 'This account is currently not available' 是正常的 —— 账号被限制成只能建隧道，没有 shell)"

echo "==> 5/6 建 launchd（隧道 + DevSpace）"
mkdir -p ~/.devspace/logs
# 🔴 -R 必须写成 127.0.0.1:PORT:... 的完整形式。
# 只写 PORT: 时 sshd 收到的监听地址是空串，和 authorized_keys 里的
# permitlisten="127.0.0.1:PORT" 匹配不上，会直接 "remote port forwarding failed"。
cat > ~/Library/LaunchAgents/com.mcp.tunnel.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mcp.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/ssh</string><string>-N</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=20</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>StrictHostKeyChecking=accept-new</string>
    <string>-R</string><string>127.0.0.1:$MCP_PORT:127.0.0.1:7676</string>
    <string>mcp-relay</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$HOME/.devspace/logs/tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/.devspace/logs/tunnel.err</string>
</dict></plist>
EOF

NODE_BIN=$(command -v node)
cat > ~/Library/LaunchAgents/com.mcp.devspace.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mcp.devspace</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string>
    <string>$DS_DIR/dist/cli.js</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS</key><string>$REDIRECT_HOSTS</string>
    <key>DEVSPACE_TRUST_PROXY</key><string>true</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.devspace/logs/serve.log</string>
  <key>StandardErrorPath</key><string>$HOME/.devspace/logs/serve.err</string>
</dict></plist>
EOF

UID_N=$(id -u)
for L in com.mcp.devspace com.mcp.tunnel; do
  launchctl bootout "gui/$UID_N/$L" 2>/dev/null || true
done
sleep 2
for L in com.mcp.devspace com.mcp.tunnel; do
  launchctl bootstrap "gui/$UID_N" ~/Library/LaunchAgents/$L.plist
done
sleep 8

echo "==> 6/6 验证"
echo "    本地 DevSpace: $(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:7676/mcp || echo 失败)   (401=正常)"
echo "    公网入口:      $(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://$MCP_FQDN/mcp || echo 失败)   (401=通了 / 502=隧道没起 / 000=本机 DNS 被代理软件劫持，换手机热点复测)"
echo "    launchd:"; launchctl list | grep -E "com\.mcp\." | sed 's/^/      /'
echo
echo "────────────────────────────────────────"
echo "在 ChatGPT 里添加（设置 → Apps → Advanced 打开 Developer mode → Connectors → Create）："
echo "  MCP server URL : https://$MCP_FQDN/mcp"
echo "  Authentication : OAuth"
echo
echo "连接时会问 Owner 密码，在这里："
echo "  cat ~/.devspace/OWNER_PASSWORD.txt"
echo "────────────────────────────────────────"
