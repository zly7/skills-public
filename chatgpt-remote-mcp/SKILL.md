---
name: chatgpt-remote-mcp
description: 把本地 Mac/机器通过远程 MCP 暴露给 ChatGPT 或 Claude 网页端，用网页端额度驱动本地干活。涵盖 ChatGPT 对 URL 的隐藏校验规则、中国大陆 ICP 备案拦截的实测边界、证书签发路径的选择、DevSpace 的非交互配置。当要搭 remote MCP、配反向隧道/Cloudflare Tunnel、或排查「does not implement OAuth」时使用。
---

# 把本地机器接到 ChatGPT 网页端（远程 MCP）

2026-09-09 实战记录。目标：用 **ChatGPT 网页端的额度**（不是 API 计费）驱动本地 Mac 读写文件、跑命令。

最终可用架构：

```
ChatGPT → https://mcp.yourdomain.cn/mcp          真实域名 + 标准 443 + Let's Encrypt
   → 腾讯云上海轻量 198.51.100.10 的 nginx     TLS 终止
   → 127.0.0.1:17676                            SSH 反向隧道落点
   → Mac 的 127.0.0.1:7676 → DevSpace           MCP server 本体
```

> 文中所有 IP 和域名均为占位示例：`198.51.100.10` / `203.0.113.20` 是 RFC 5737 文档专用地址（分别代表境内、境外服务器），`yourdomain.cn` 代表你自己的域名。端口号（`7676` / `17676`）、错误码、价格、命令参数都是实测真值，可以照抄。

---

## 一、ChatGPT 对 MCP server URL 有隐藏的域名校验（最大的坑）

报错长这样，**极具误导性**：

```
获取 OAuth 配置时出错
MCP server https://xxx/mcp does not implement OAuth
```

这句话跟 OAuth **一点关系都没有**。实测：

| URL 形式 | 结果 |
|---|---|
| `https://198.51.100.10/mcp`（裸 IP） | ✗ 拒绝 |
| `https://203.0.113.20.sslip.io/mcp`（IP-to-domain 服务） | ✗ 拒绝 |
| `https://xxx.trycloudflare.com/mcp` | ✓ 接受 |
| `https://mcp.yourdomain.cn/mcp`（真实注册域名） | ✓ 接受 |

`sslip.io` / `nip.io` 这类把 IP 编进域名的服务被拒，推测是因为它们常被用于钓鱼和绕过检测，在信誉黑名单里。

### 🔴 判据：怎么知道是这个问题

**服务端的 `access.log` 和 `error.log` 里查不到任何记录。**

```bash
# 两个都空 = 请求根本没发出，问题在 ChatGPT 客户端侧的 URL 校验
tail -50 /var/log/nginx/access.log
grep -iE "SSL_do_handshake|ssl handshake|unknown ca" /var/log/nginx/error.log
```

`error.log` 尤其关键：**TLS 握手失败不会进 access.log，只会进 error.log**。所以两个日志都干净，说明连 TCP 连接都没建立。看到这个信号立刻停止排查服务端配置。

我在这上面浪费了很久，还先错误归因为「裸 IP」，直到 sslip.io 域名也被拒才反应过来是域名信誉。

### ChatGPT 侧的硬性要求（已验证）

- 认证必须是 **OAuth 2.1 + Dynamic Client Registration**，不收 bearer token / API key
- `code_challenge_methods_supported` 必须包含 `S256`，否则直接不支持
- 传输支持 Streamable HTTP 和 SSE；输入框里灰色的 `https://example.com/sse` 是**占位符不是默认值**，新协议端点应填 `/mcp`
- 要先在 设置 → Apps → Advanced 打开 **Developer mode**

---

## 二、中国大陆 ICP 备案拦截的实测边界

**未备案域名指向境内服务器 IP** 时（从美国机器实测）：

| 访问方式 | 结果 |
|---|---|
| 域名 → 80 | HTTP **566**，劫持到 `https://dnspod.qcloud.com/static/webblock.html?d=<域名>` |
| 域名 → 443 | **Connection reset by peer**，TLS 握手阶段就被掐断（SNI 检测） |
| 域名 → 8443 | **可穿透**，拿到的是自己 nginx + 后端的真实响应 |
| **裸 IP** → 443 | 200 正常（拦截只针对域名，不针对 IP） |

判断 8443 那个响应是谁给的，**要看响应体不能只看状态码**：

```bash
# 拿到这个就说明请求穿透了整条链路，403 是后端应用给的（Host 白名单），不是被拦
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: xxx"}}
Server: nginx/1.24.0 (Ubuntu)
```

### 🔴 推论：Let's Encrypt 在境内服务器上签不了域名证书

- HTTP-01 走 80 → 被劫持
- TLS-ALPN-01 走 443 → 被 reset
- **只剩 DNS-01**

绕过办法（本次用的）：**趁域名还指向境外服务器时先把证书签下来，再改 DNS**。证书不绑 IP，签完随便改解析。

### ⚠️ 但拦截不是必然的

`yourdomain.cn`（当天新注册）指向腾讯云上海后，**80 和 443 都没被拦**：443 连打 6 次全是正常 401，80 返回 200 而不是 webblock 页。而同一台机器上 `sslip.io` 域名的 443 是被 reset 的。

推测新注册域名还没进扫描名单，或者 `sslip.io` 这类服务在黑名单里。**结论：别假设一定被拦，实测一次**；但也别假设永远不被拦，腾讯云会周期性扫描，随时可能开始拦——真被拦了就切 8443。

---

## 三、Cloudflare 新账号建不了 zone

```
code 1106: You are not allowed to create new zones at this time.
           ... please email abusereply@cloudflare.com
```

当天新注册的账号（`created_on` 就是今天）+ 立刻调 API 建 zone，触发反滥用风控。**API 和面板走同一套判定，面板也过不去**，不用白试。

自助解法（按见效速度）：绑一张信用卡（不扣费，当身份可信度信号）> 验证注册邮箱 > 发邮件给 `abusereply@cloudflare.com` 等 1-3 个工作日。

### 顺带：Cloudflare API token 的 verify 端点会骗人

```bash
# 这个返回 Invalid API Token，不代表 token 无效！
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer $T"
#   {"success":false,"errors":[{"code":1000,"message":"Invalid API Token"}]}

# 直接调实际要用的端点才是准的
curl "https://api.cloudflare.com/client/v4/zones" -H "Authorization: Bearer $T"
#   {"success":true,"result":[]}      ← token 其实完全可用
```

原因是 verify 端点需要 token 具备 `User → API Tokens → Read` 权限，没勾就报无效。**别拿 verify 的结果判定 token 死活。**

---

## 四、Cloudflare Quick Tunnel 的硬伤

```bash
cloudflared tunnel --url http://127.0.0.1:7676   # 不需要账号，立刻可用
```

给出的 `xxx.trycloudflare.com` **每次重启都换一个随机域名**。一变就要同时改两处：

1. ChatGPT 里的 connector（得删了重加）
2. MCP server 的 `publicBaseUrl`（否则 OAuth 元数据里 issuer 对不上）

而且它默认是手动起的（`PPID=1`），Mac 重启就没了。要固定 URL 必须上 **Named Tunnel**，那需要账号 + 一个挂在 Cloudflare 的域名。

---

## 五、DevSpace（本次用的 MCP server）

```bash
npm i -g @waishnav/devspace     # 需要 node >=22.19 <27
devspace doctor                  # 一眼看全部配置
```

- 默认监听 **`127.0.0.1:7676`**，端点 `/mcp`
- 自带完整 OAuth 2.1 + DCR + S256，满足 ChatGPT 的强制要求
- Owner 密码是 `devspace init` **自己生成**的，不是用户设的

### 非交互配置（`devspace init` 是 clack TUI，难自动化）

直接调它自己的模块写配置，保证格式与 init 完全一致：

```bash
cd /opt/homebrew/lib/node_modules/@waishnav/devspace && node --input-type=module -e "
import { writeDevspaceConfig, writeDevspaceAuth, generateOwnerToken, loadDevspaceFiles } from './dist/user-config.js';
const files = loadDevspaceFiles();
writeDevspaceConfig({...files.config, host:'127.0.0.1', port:7676,
  allowedRoots:['/Users/<you>'], publicBaseUrl:'https://mcp.yourdomain.cn'});
writeDevspaceAuth({ ownerToken: files.auth.ownerToken ?? generateOwnerToken() });
"
```

- `~/.devspace/config.json`：`host` / `port` / `allowedRoots` / `publicBaseUrl`
- `~/.devspace/auth.json`：`ownerToken`（= `randomBytes(32).base64url`）
- 两个文件都是 `0600`
- **`allowedHosts` 从 `publicBaseUrl` 自动派生**，不用单独配。`publicBaseUrl` 写错会导致所有请求被 `Invalid Host` 403
- `publicBaseUrl` 带非标端口时必须写全（`https://x.com:8443`），否则元数据里的 issuer 指回 443

### 🔴 三个已知缺陷

1. **`/.well-known/oauth-protected-resource`（不带 `/mcp` 后缀）DevSpace 不实现**，只有带后缀的。ChatGPT 靠 `WWW-Authenticate` 头里的 `resource_metadata` 找到正确路径所以没事，但严格按 RFC 9728 只请求根路径的客户端会 404。反代层加 rewrite 可补：

```nginx
location = /.well-known/oauth-protected-resource {
    rewrite ^ /.well-known/oauth-protected-resource/mcp last;
}
# RFC 8414 路径插入变体，某些客户端会请求这个
location = /.well-known/oauth-authorization-server/mcp {
    rewrite ^ /.well-known/oauth-authorization-server last;
}
```

2. **没开 express 的 `trust proxy`**，经反代进来的请求限流全算成同一个 IP（`127.0.0.1`）。公网扫描器和真实客户端共用一份配额，扫得凶时可能把正常请求也限掉。

3. **🔴 OAuth 状态全存在内存里，进程一重启授权就作废。**

```bash
ls ~/.devspace/       # 只有 config.json 和 auth.json，没有任何 sqlite/db 文件
```

后果很隐蔽：launchd 配了 `KeepAlive`，DevSpace 崩溃会被自动拉起——**进程看着是活的，但客户端那边已经掉线**，表现出来就是「刚刚还能用，现在连不上」。每次改配置做 `kickstart` 也一样会踢掉已授权的客户端。

排查时先确认进程有没有重启过，别一上来查网络：

```bash
ps -o pid,lstart,etime -p <pid>              # 启动时刻是否晚于最后一次成功请求
grep -c "devspace listening" ~/.devspace/logs/serve.log   # 启动次数
```

Access token TTL 默认 3600 秒、refresh token 30 天（`DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` / `..._REFRESH_...` 可调），所以**一小时内掉线基本不是 token 过期，优先怀疑进程重启**。

---

## 五之二、macOS 上的两层权限（容易只做一半）

想让 MCP 真正「操控整台 Mac」，要分别放开两层，**只做一层会出现「配置写了 `/` 但还是读不到某些目录」**：

### 第一层：MCP server 自己的范围

```json
// ~/.devspace/config.json
{ "allowedRoots": ["/"] }        // 从 ["/Users/xxx"] 扩到整个文件系统
```

改完要重启进程生效（于是又会踢掉 OAuth 授权，见上一节）。

### 第二层：macOS TCC（完全磁盘访问权限）

即使 `allowedRoots` 是 `/`，这些目录仍然读不到：

```
✗ ~/Library/Mail   ~/Library/Messages   ~/Library/Safari
✓ ~/Desktop  ~/Documents  ~/Downloads    （这几个只要授权过一次终端类应用就行）
```

要放开得在 系统设置 → 隐私与安全性 → **完全磁盘访问权限** 里添加 node 二进制。

🔴 **必须填软链解析后的真实路径**，TCC 按可执行文件本体判定：

```bash
readlink -f /opt/homebrew/bin/node
# → /opt/homebrew/Cellar/node/26.5.0/bin/node    ← 加这个
```

🔴 **node 升级后这个路径会变（26.5.0 → 27.x），FDA 授权随之失效**，症状是「本来能读的目录突然读不到了」。升级 node 后要重新添加一次。

🔴 **TCC 权限按进程的可执行文件归属，不按启动者**。所以在终端里 `ls ~/Library/Mail` 能成功，不代表 launchd 拉起的 node 能成功——终端有自己的授权。测权限必须以实际运行的那个进程为准，别在终端里试完就以为通了。

加完 FDA 要重启进程才生效。**把「改 allowedRoots」和「加 FDA」合并成一次重启**，否则客户端要重新授权两遍。

---

## 六、反向隧道（Mac 在 NAT 后面）

服务器端口 ≠ 本地端口，**隧道本身就能做映射，不用改 nginx 去迁就默认端口**：

```bash
ssh -N -R 17676:127.0.0.1:7676 <server>    # 服务器 17676 → Mac 7676
```

`sshd_config` 保持 `GatewayPorts no`（默认），反向隧道只监听 `127.0.0.1`，外部无法直连隧道端口，只能经 nginx。

### 🔴 判断隧道通没通，看 nginx 报错的措辞

```
connect() failed (111: Connection refused)         → 隧道断了，没人监听那个端口
recv() failed (104: Connection reset by peer)      → 隧道通了，但 Mac 上的服务没起
```

两者完全不同，别混。

### launchd 保活（macOS）

```xml
<key>KeepAlive</key><true/>
<key>RunAtLoad</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
```

**launchd 下 PATH 极简**，`ProgramArguments` 和 `ProxyCommand` 里所有路径必须写绝对路径（`/usr/bin/python3` 而不是 `python3`）。

---

## 七、其它踩到的坑

### ssh config 里同名 Host 取先出现的那个

改 `User` 时在文件尾部追加了第二个 `Host tencent-mcp` 块，结果一直用前一个的 `User`，报 `Permission denied` 查了半天。**ssh 是 first-obtained wins，不是后者覆盖。**

### Clash TUN 会劫持 DNS 查询和国内 IP

```bash
dig +short 198.51.100.10.sslip.io    # → 198.18.0.35  ← fake-ip，不是真实解析
route -n get <国内IP>                  # → interface: utun1024  ← 被劫持
```

`198.18.0.0/16` 是 Clash 的 fake-ip 段。**在 Mac 上判断 DNS 解析和连通性全是假信号**，必须到服务器上查。SSH 要绕开得用 `IP_BOUND_IF`（=25）绑物理网卡，`--interface` / `BindInterface` 都没用。

### certbot 1.21 的 standalone 不支持 tls-alpn-01

```
None of the preferred challenges are supported by the selected plugin
```

只能用 http-01，也就是必须借用 80 端口。如果 80 上有生产服务，**用 trap 保证它一定被拉回来**：

```bash
restore() { systemctl start <service>; echo "恢复: $(systemctl is-active <service>)"; }
trap restore EXIT INT TERM
systemctl stop <service>
certbot certonly --standalone -d <domain> --non-interactive --agree-tos \
  --register-unsafely-without-email
```

实测中断约 20 秒。

### 证书跨机器搬运

签证书的机器和用证书的机器可以不是同一台（证书不绑 IP）：

```bash
ssh <签证书的机器> 'sudo cat /etc/letsencrypt/live/<d>/fullchain.pem' > fullchain.pem
ssh <签证书的机器> 'sudo cat /etc/letsencrypt/live/<d>/privkey.pem'   > privkey.pem
chmod 600 privkey.pem
scp *.pem <用证书的机器>:/etc/nginx/ssl-mcp/
```

ECDSA 密钥**不能用 `openssl x509 -modulus` 比对**是否匹配（那只对 RSA 有效）。

### certbot 续期后要 reload nginx

renewal conf 里没有 hook 是正常的，检查 service 的命令行：

```bash
systemctl cat certbot-renew.service | grep ExecStart
# ExecStart=/opt/certbot/bin/certbot renew --quiet --deploy-hook "/usr/bin/systemctl reload nginx"
```

---

## 八、腾讯云 CLI 备忘

```bash
# 域名可注册性 + 价格（Tld 要带点号，如 ".com"；不传参数返回全量价格表）
tccli domain CheckDomain --DomainName x.cn
tccli domain DescribeDomainPriceList          # Operation: new/renew/tran

# 下单。PayMode: 0=手动在线付费 1=余额 2=特惠包
# 用 0 可以绕开余额不足，生成订单后去控制台用微信/支付宝付
tccli domain CreateDomainBatch --TemplateId <tmpl-xxx> --Period 1 \
  --Domains '["x.cn"]' --PayMode 0 --AutoRenewFlag 0

# 🔴 查域名真实状态用这个，DescribeDomainNameList 会返回一堆 None 脏数据
tccli domain DescribeDomainBaseInfo --Domain x.cn
#   RealNameAuditStatus: Approved / DomainStatus: ["ok"] / NameServer

# DNSPod 解析
tccli dnspod CreateRecord --Domain x.cn --SubDomain mcp --RecordType A \
  --RecordLine 默认 --Value <ip> --TTL 600
tccli dnspod ModifyRecord --Domain x.cn --RecordId <id> ... --Value <新ip>
tccli dnspod DescribeRecordList --Domain x.cn

# 云助手远程执行（机器没配 SSH key 时用它写公钥）
tccli tat RunCommand --InstanceIds '["ins-xxx"]' --Content <base64> \
  --CommandType SHELL --Username root
tccli tat DescribeInvocationTasks --HideOutput False \
  --Filters '[{"Name":"invocation-id","Values":["inv-xxx"]}]'
```

### 域名后缀：便宜后缀是钓鱼定价

首年 vs 续费（腾讯云 2026-09 实价）：

| 后缀 | 首年 | 续费/年 | 倍数 |
|---|---|---|---|
| .cn | 33 | 38 | 1.2x |
| .com | 83 | 90 | 1.1x |
| .top | 14 | 34 | 2.4x |
| .site / .online | 11 | **122** | 11x |
| .cloud | 12 | **169** | 14x |
| .fun | 11 | **215** | **20x** |
| .shop / .tech | 15 | **254 / 258** | 17x |

`.site` 续费 122 元**比 .com 的 90 元还贵**。持有两年以上，所谓便宜后缀全面输给 .com。而且这批后缀恰好是域名信誉最差的一类（垃圾邮件重灾区），在本文第一节那个校验上有额外风险。**别为省首年那几十块选 .site/.fun/.xyz。**

---

## 九、方案选型总结

| 方案 | 可行 | 说明 |
|---|---|---|
| 裸 IP + 自有服务器 | ✗ | ChatGPT 拒绝裸 IP |
| sslip.io/nip.io + 自有服务器 | ✗ | 域名信誉被拒 |
| Cloudflare Quick Tunnel | ✓ | 零配置最快，但 URL 每次重启就变 |
| Cloudflare Named Tunnel | ✓ | URL 固定，需账号 + 自有域名；新账号可能撞 1106 |
| **真实域名 + 自有服务器 + 443** | ✓ | 本次最终方案。境内服务器需注意备案拦截 |
| 真实域名 + 境内服务器 + 8443 | ? | 能穿透备案拦截，但 ChatGPT 是否接受非标端口未验证 |

**最省事的起步**：先用 Quick Tunnel 跑通，确认 MCP server 本身没问题；再换固定域名。反过来做（先折腾域名）会把「服务端配置问题」和「URL 被拒问题」混在一起，很难定位。

---

## 附：凭据放在哪

本文不含任何活凭据。实际值在本地：

- DevSpace Owner 密码 → `~/.devspace/auth.json` 的 `ownerToken`
- 隧道 SSH 私钥 → `~/.ssh/tencent_mcp_tunnel`
- 腾讯云凭据 → `~/.tccli/default.credential`
- Cloudflare API token → 用完即弃，需要时在 Dashboard 重建
