#!/usr/bin/env bash
# 给同学开一个 MCP 接入账号（在你的 Mac 上跑）
#
#   ./add-mcp-user.sh <名字> <他发给你的公钥>
#
# 例：
#   ./add-mcp-user.sh alice "ssh-ed25519 AAAAC3Nza... alice@her-mac"
#
# 做四件事：分配端口 → 加 DNS 记录 → 服务器上建受限用户+签证书+配 nginx → 输出给他的配置
set -euo pipefail

# ⚠️ 下面四个值必须改成你自己的：域名、服务器公网 IP、~/.ssh/config 里管理员登录用的别名。
#    DOMAIN / SERVER_IP 现在是 RFC 5737 文档占位地址，照抄跑不通。
DOMAIN=yourdomain.cn
SERVER_IP=198.51.100.10
SSH_HOST=relay-admin          # ~/.ssh/config 里的别名（root 登录，用于管理）
PORT_BASE=17677               # 17676 已被你自己占用，同学从 17677 开始

NAME="${1:-}"
PUBKEY="${2:-}"
if [[ -z "$NAME" || -z "$PUBKEY" ]]; then
  echo "用法: $0 <名字> <公钥>" >&2
  echo "  名字只能用小写字母和数字，例：alice / bob2" >&2
  exit 1
fi
[[ "$NAME" =~ ^[a-z][a-z0-9]{1,15}$ ]] || { echo "✗ 名字只能是小写字母开头、2-16 位字母数字" >&2; exit 1; }
[[ "$PUBKEY" =~ ^(ssh-ed25519|ssh-rsa)\  ]] || { echo "✗ 公钥格式不对，应以 ssh-ed25519 或 ssh-rsa 开头" >&2; exit 1; }

USER="mcp-$NAME"
SUB="mcp-$NAME"
FQDN="$SUB.$DOMAIN"

echo "==> 1/5 分配隧道端口"
USED=$(ssh -o ConnectTimeout=15 "$SSH_HOST" "grep -rhoE 'permitlisten=\"127.0.0.1:[0-9]+\"' /home/*/.ssh/authorized_keys 2>/dev/null | grep -oE '[0-9]+$' | sort -n" || true)
PORT=$PORT_BASE
while echo "$USED" | grep -qx "$PORT"; do PORT=$((PORT+1)); done
echo "    $USER -> 127.0.0.1:$PORT   $FQDN"

echo "==> 2/5 添加 DNS 记录"
if tccli dnspod DescribeRecordList --region ap-guangzhou --Domain "$DOMAIN" 2>/dev/null \
   | python3 -c "import json,sys; print('\n'.join(r['Name'] for r in json.load(sys.stdin).get('RecordList',[])))" \
   | grep -qx "$SUB"; then
  echo "    记录已存在，跳过"
else
  tccli dnspod CreateRecord --region ap-guangzhou --Domain "$DOMAIN" \
    --SubDomain "$SUB" --RecordType A --RecordLine 默认 --Value "$SERVER_IP" --TTL 600 >/dev/null
  echo "    已添加 $FQDN -> $SERVER_IP"
fi

echo "==> 3/5 等 DNS 生效"
for i in $(seq 1 30); do
  R=$(dig +short A "$FQDN" @8.8.8.8 2>/dev/null | head -1 || true)
  [[ "$R" == "$SERVER_IP" ]] && { echo "    ✓ 已生效"; break; }
  sleep 4
done
[[ "${R:-}" == "$SERVER_IP" ]] || { echo "    ✗ DNS 30 次查询后仍未生效，中止" >&2; exit 1; }

echo "==> 4/5 服务器上开户（受限用户 + 证书 + nginx）"
ssh -o ConnectTimeout=25 "$SSH_HOST" "sudo bash -s" <<REMOTE
set -e
USER=$USER; FQDN=$FQDN; PORT=$PORT

# 受限用户：无 shell，只能开自己那一个端口的反向隧道
id \$USER >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin \$USER
install -d -m 700 -o \$USER -g \$USER /home/\$USER/.ssh
cat > /home/\$USER/.ssh/authorized_keys <<KEYS
restrict,port-forwarding,permitlisten="127.0.0.1:\$PORT",no-agent-forwarding,no-x11-forwarding,no-user-rc $PUBKEY
KEYS
chown \$USER:\$USER /home/\$USER/.ssh/authorized_keys
chmod 600 /home/\$USER/.ssh/authorized_keys

# 证书：webroot 模式，80 上是 nginx，不用停任何服务
if [ ! -f /etc/letsencrypt/live/\$FQDN/fullchain.pem ]; then
  /opt/certbot/bin/certbot certonly --webroot -w /var/www/html -d \$FQDN \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --deploy-hook "/usr/bin/systemctl reload nginx" >/dev/null
fi

cat > /etc/nginx/sites-available/mcp-\$USER <<CONF
server {
    listen 443 ssl;
    listen 8443 ssl;
    server_name \$FQDN;

    ssl_certificate     /etc/letsencrypt/live/\$FQDN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/\$FQDN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location = /.well-known/oauth-protected-resource {
        rewrite ^ /.well-known/oauth-protected-resource/mcp last;
    }
    location = /.well-known/oauth-authorization-server/mcp {
        rewrite ^ /.well-known/oauth-authorization-server last;
    }
    location / {
        proxy_pass http://127.0.0.1:\$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \\\$http_host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
CONF
ln -sf /etc/nginx/sites-available/mcp-\$USER /etc/nginx/sites-enabled/mcp-\$USER
nginx -t >/dev/null && systemctl reload nginx
echo "    ✓ 用户 \$USER / 端口 \$PORT / 证书 \$FQDN / nginx 已就绪"
REMOTE

echo "==> 5/5 完成，把下面这段发给 $NAME"
cat <<INFO

────────── 发给 $NAME 的内容（从这里开始复制）──────────
你的 MCP 接入信息：

  服务器别名   mcp-relay
  服务器地址   $SERVER_IP
  SSH 用户名   $USER
  隧道端口     $PORT
  你的 URL     https://$FQDN/mcp

按 setup-for-classmate.md 里的步骤在你自己 Mac 上配置。
遇到问题把报错发我。
──────────────── 复制到这里结束 ────────────────

验证（等他配好后跑）：
  curl -sS -o /dev/null -w "%{http_code}\n" https://$FQDN/mcp
  期望 401（要鉴权=通了），502 表示他的隧道没起来
INFO
