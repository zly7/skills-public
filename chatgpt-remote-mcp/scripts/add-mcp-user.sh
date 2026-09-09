#!/usr/bin/env bash
# 【管理员】在自己机器上跑，给一个使用者开通 MCP 中转。
# 做三件事：加 DNS 解析 → 在中转服务器上建受限隧道账号+Caddy 站点 → 打印发给对方的四个值。
#
#   ./add-mcp-user.sh alice "ssh-ed25519 AAAAC3Nz... alice@mac"
#
# 依赖：tccli（已配好密钥）、能 ssh 到中转服务器的 root。
set -euo pipefail

RELAY_HOST="${RELAY_HOST:-relay-admin}"          # ssh 别名，需能 root 登录
RELAY_IP="${RELAY_IP:-203.0.113.20}"
DOMAIN="${DOMAIN:-yourdomain.cn}"

NAME="${1:-}"; PUBKEY="${2:-}"
[[ -n "$NAME" && -n "$PUBKEY" ]] || { echo "用法: $0 <name> \"<ssh 公钥整行>\"" >&2; exit 1; }
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,20}$ ]] || { echo "name 只能小写字母/数字/连字符" >&2; exit 1; }
[[ "$PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-) ]] || { echo "公钥格式不对" >&2; exit 1; }

SUB="mcp-$NAME"
FQDN="$SUB.$DOMAIN"

echo "==> 1/3 添加解析 $FQDN -> $RELAY_IP"
# TTL 最低 600，传更小的值 DNSPod 会静默失败
if tccli dnspod DescribeRecordList --Domain "$DOMAIN" --Subdomain "$SUB" --output json 2>/dev/null \
     | grep -q '"RecordId"'; then
    echo "    已存在，跳过"
else
    tccli dnspod CreateRecord --Domain "$DOMAIN" --SubDomain "$SUB" --RecordType A \
        --RecordLine 默认 --Value "$RELAY_IP" --TTL 600 --output json >/dev/null
    echo "    已添加"
fi

echo "==> 2/3 在中转服务器上开户"
OUT=$(ssh "$RELAY_HOST" "/usr/local/sbin/mcp-adduser '$NAME' '$PUBKEY' '$FQDN'" </dev/null 2>&1)
echo "$OUT" | grep -E '^OK|^反向隧道' || { echo "$OUT" >&2; exit 1; }
PORT=$(echo "$OUT" | sed -nE 's/.*端口=([0-9]+).*/\1/p')

echo "==> 3/3 等 Caddy 签证书（首次访问该域名时自动触发 Let's Encrypt）"
for i in $(seq 1 20); do
    code=$(ssh "$RELAY_HOST" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$FQDN/healthz" </dev/null 2>/dev/null || echo 000)
    # 502 = 证书已好、隧道还没起（对方还没装）；这就算成功
    if [[ "$code" == "502" || "$code" == "200" ]]; then echo "    证书就绪 (HTTP $code)"; break; fi
    [[ $i == 20 ]] && echo "    ⚠ 20 次仍未就绪，查 journalctl -u caddy"
    sleep 3
done

cat <<EOF

────────── 发给 $NAME 的四个值 ──────────
MCP_USER=mcp-$NAME
MCP_PORT=$PORT
MCP_FQDN=$FQDN
MCP_SERVER_IP=$RELAY_IP

对方最终在 ChatGPT 里填：https://$FQDN/mcp
──────────────────────────────────────
EOF
