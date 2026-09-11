---
name: chatgpt-remote-mcp
description: 把本地或内网 MCP server 接到 ChatGPT / Codex / Claude，并系统排查 OAuth、域名、反向隧道和重启后的授权问题。包含 2026-09-11 更新后的错误诊断树、Secure MCP Tunnel 选型、DevSpace 持久化、CIMD/DCR 迁移、refresh token 与 Caddy/SSH 实战。当遇到 does not implement OAuth、invalid_client、authorization expired、owner credential、502/隧道断开时使用。
---

# Remote MCP 接 ChatGPT：2026-09-11 维护版

这份 skill 记录的是**判据、被推翻的假设和可复用排障顺序**，不是某一台机器的一次性安装笔记。

最重要的更新：

1. `does not implement OAuth` **不是单一根因**。2026-09-09 曾遇到 ChatGPT 根本没有请求服务端却显示此错误；2026-09-11 又验证了“服务端确实没有 OAuth discovery”也会触发同一文案。
2. DevSpace 的 OAuth 状态**不是只存在内存**，而是持久化到 SQLite；普通进程/机器重启不应要求重新在 ChatGPT 配置。
3. `DEVSPACE_TRUST_PROXY=true` 存在。旧笔记里“DevSpace 没有 trust proxy”已经被推翻。
4. MCP 2026-07-28 已正式把 Dynamic Client Registration（DCR）标记为 deprecated，方向是 Client ID Metadata Documents（CIMD）。DCR 仍为兼容路径，但新实现不要再把它写成长期唯一方案。
5. ChatGPT 使用 OAuth 时，要关注 refresh token / `offline_access`。否则初次授权能成功，授权过期后仍可能失联。
6. 只服务 OpenAI 产品时，应先评估 **OpenAI Secure MCP Tunnel**；需要同时服务 ChatGPT、Claude、其他 MCP client 时，再考虑自建公网 HTTPS + OAuth + 反向隧道。

官方参考：

- OpenAI Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- ChatGPT Developer mode / MCP apps: https://help.openai.com/en/articles/12584461
- MCP 2026-07-28: https://blog.modelcontextprotocol.io/posts/2026-07-28/

---

## 一、先画清楚四层，不要把所有问题都叫“MCP 挂了”

典型公网自建链路：

```text
ChatGPT / Claude / Codex
        ↓
公网 URL + OAuth discovery
        ↓
Caddy / nginx / tunnel gateway
        ↓
SSH reverse tunnel / Cloudflare Tunnel
        ↓
本地 MCP server
```

排障必须按层看。浏览器控制类场景还要再拆一层：

```text
ChatGPT
  ├─ shell/files MCP
  └─ Playwright MCP
          ↓
       browser
```

**Playwright MCP、shell/files MCP、CUA 是不同能力面。** 不要因为最终都从 ChatGPT 调用，就把它们套成一个进程或共享一套状态。

---

## 二、`does not implement OAuth` 的正确诊断树

ChatGPT 可能显示：

```text
获取 OAuth 配置时出错
MCP server https://example.com/mcp does not implement OAuth
```

不要立刻相信字面含义，也不要立刻假定它“一定与 OAuth 无关”。按下面顺序判断。

### A. 服务端完全没有请求

同时看反代 access/error log：

```bash
tail -100 /var/log/caddy/access.log 2>/dev/null || true
tail -100 /var/log/nginx/access.log 2>/dev/null || true
tail -100 /var/log/nginx/error.log 2>/dev/null || true
```

如果发起连接的时间点，服务端**完全没有 TCP/TLS/HTTP 痕迹**，问题在更上游：

- URL / 域名预检
- DNS
- TLS 到达前的阻断
- ChatGPT 侧输入/连接配置

2026-09-09 的实测里，裸 IP、`sslip.io`/`nip.io` 这类域名曾被 ChatGPT 拒绝，而真实注册域名和 `trycloudflare.com` 能进入后续流程。

**判据比错误文案可靠：没有请求，就不要继续改 OAuth server。**

### B. `/.well-known/...` 请求到了，但返回 404 / 元数据缺字段

这时才是真的 OAuth discovery / protected-resource metadata 问题。

常检查：

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/.well-known/openid-configuration
```

不同 server / client 对 RFC 9728、RFC 8414 的路径兼容性不同。不要只测 `/mcp` 本体 200/401 就宣布 OAuth 正常。

### C. 已经进入授权，但报 `invalid_client`

这说明 discovery 基本已经过去，问题进入 client registration / issuer 绑定层。

优先检查：

1. `client_id` 是否来自当前 authorization server。
2. authorization server 重启后，client registry 是否真的持久化。
3. FQDN / issuer 是否换过。
4. 是否把 A 域名注册出的 client_id 拿去 B 域名或另一套 auth server 使用。
5. 反代是否把不同域名路由到不同 auth 状态库。

MCP 2026-07-28 进一步要求 client credentials 与签发它们的 issuer 绑定；不要跨 issuer 复用。

### D. `Incorrect owner credential`

这是**应用自己的 owner approval / 管理员凭据层**，不等于 OAuth discovery 坏了。

排查顺序：

```text
OAuth discovery 是否成功
→ authorization request 是否创建成功
→ owner approval 页面读的是哪一份 credential
→ credential 是否与正在运行的进程/配置一致
```

不要为了修 owner credential 去重建整个公网 MCP。

### E. `Authorization request expired. Reconnect from ChatGPT.`

这是授权 transaction 已经过期。旧的 authorization URL / request id 不应该继续复用。

正确动作：

1. 回到 ChatGPT 重新触发连接。
2. 使用**新生成**的 authorization request。
3. 如果新请求仍然瞬间过期，再检查服务器时钟、TTL、状态存储和多实例路由。

---

## 三、OAuth：2026-09 以后不要再把 DCR 写死成唯一答案

历史上很多 ChatGPT remote MCP 实现通过：

- OAuth 2.x
- PKCE S256
- Dynamic Client Registration

跑通了连接。

但 MCP `2026-07-28` 已正式把 **DCR deprecated**，迁移方向是 **Client ID Metadata Documents (CIMD)**。DCR 仍然可用于兼容旧客户端/旧授权服务器。

因此新的 runbook 应写成：

```text
优先遵循目标客户端当前支持的 MCP/OAuth discovery
→ 新实现优先考虑 CIMD
→ 需要兼容旧客户端时保留 DCR
→ 不要假设“能 POST /register”就是永远正确的最终形态
```

仍然要检查 PKCE：

```json
{
  "code_challenge_methods_supported": ["S256"]
}
```

### refresh token / `offline_access`

OpenAI 当前帮助文档明确提醒：如果 OAuth/OIDC 没有配置 refresh token，原始授权过期后 ChatGPT 可能失去访问，需要重新认证。

如果 provider 使用 `offline_access`，检查 discovery 是否声明：

```json
{
  "scopes_supported": ["openid", "offline_access"]
}
```

并确认 token endpoint 实际签发 refresh token。只在 metadata 写字段、不实际签发，没有意义。

---

## 四、DevSpace：已经验证的结论

历史使用：

```bash
npm i -g @waishnav/devspace
devspace doctor
```

默认典型值：

```text
127.0.0.1:7676
/mcp
```

### 1. OAuth 状态会持久化

数据库在 stateDir，常见位置：

```bash
~/.local/share/devspace/devspace.sqlite
```

检查：

```bash
sqlite3 ~/.local/share/devspace/devspace.sqlite ".tables"
```

可见类似：

```text
oauth_clients
oauth_access_tokens
oauth_refresh_tokens
workspace_sessions
```

判据：`oauth_clients` 里存在早于当前进程启动时间的记录，就证明状态跨重启存活。

因此：

> **DevSpace 正常重启 ≠ ChatGPT 必须删掉重新添加。**

如果重启后立刻 `invalid_client`，优先怀疑你跑的已不是同一套状态目录、同一用户、同一 issuer，或已经换成了自建 OAuth wrapper。

### 2. `DEVSPACE_TRUST_PROXY` 存在

旧结论“没有 express trust proxy”已推翻。

经 Caddy/nginx 反代时设置：

```bash
DEVSPACE_TRUST_PROXY=true
```

判据：日志里的客户端 IP 不再全部变成 `127.0.0.1`，并且不再持续出现：

```text
ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
```

### 3. OAuth redirect host 白名单

历史版本里，Claude 连接曾因 redirect host 不在默认白名单而返回：

```text
400 Client redirect_uri is not allowed
```

曾验证可通过类似配置扩展：

```bash
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS=chatgpt.com,claude.ai,claude.com,localhost,127.0.0.1
```

具体环境变量名应以当前安装版本为准；升级后先 `devspace doctor` / 查当前文档，不要把 2026-09 的实现细节当永久 API。

### 4. `publicBaseUrl` / Host 很关键

`publicBaseUrl` 错了会造成：

- issuer 指错
- `Invalid Host`
- OAuth metadata 指向另一端口/域名

非标准端口必须写全。

---

## 五、不要再写“改 allowedRoots 会踢掉 OAuth”

这条旧笔记是错误推论。

`allowedRoots` 修改需要重启 server 才生效，但 DevSpace OAuth state 已验证持久化，所以：

```text
改 allowedRoots
→ 重启 DevSpace
→ OAuth client/token 状态通常仍在
```

macOS 仍然有两层权限：

1. MCP server 的 allowed roots。
2. macOS TCC / Full Disk Access。

TCC 对真实可执行文件路径生效；Homebrew Node 升级后真实路径可能改变，因此 FDA 可能需要重新授权。

```bash
readlink -f /opt/homebrew/bin/node
```

不要用 Terminal 自己能否读取 `~/Library/...` 来代表 launchd 下的 Node 也有同样权限。

---

## 六、反向隧道：最容易写错的是 listen address

安全的典型结构：

```text
Caddy :443
  ↓
127.0.0.1:<relay-port>
  ↓ SSH reverse tunnel
127.0.0.1:<local-mcp-port>
```

受限 SSH 用户配 `permitlisten="127.0.0.1:PORT"` 时，客户端 `-R` 也要显式写监听地址：

```bash
ssh -N \
  -R 127.0.0.1:17676:127.0.0.1:7676 \
  <relay-host>
```

只写：

```bash
-R 17676:127.0.0.1:7676
```

在某些 sshd/authorized_keys 组合下会因为监听地址匹配不上而被 `permitlisten` 拒绝。

中转服务器保持：

```text
GatewayPorts no
```

让 reverse port 只监听 loopback。

### nginx/Caddy 报错可以区分哪一段坏了

历史 nginx 判据：

```text
connect() failed (111: Connection refused)
→ relay 本地没人监听，通常是 tunnel 没起来

recv() failed (104: Connection reset by peer)
→ relay 已经连到 tunnel，但 tunnel 后面的本地服务异常/退出
```

---

## 七、启动方式：登录后启动和真正开机启动不是一回事

### macOS

`LaunchAgent` 属于 `gui/<uid>` 域：**用户登录后**才跑。

真正开机、不依赖 GUI 登录：使用 `LaunchDaemon`，并明确 `UserName`。

迁移时先 bootout/移走旧 LaunchAgent，避免两份进程抢同一个端口。

开机阶段网络可能尚未就绪，SSH 第一次退出不代表配置坏了；靠 `KeepAlive` / 重试拉起。

### Windows

“登录时触发”的计划任务也不是“系统启动时触发”。

如果要无人值守，明确使用启动触发器，并确认运行用户、工作目录、Node 路径、私钥路径在非交互环境也能访问。

PowerShell 5.1 两个历史坑：

- `Set-Content -Encoding utf8` 可能写 BOM，Node 直接 `JSON.parse` 时会炸。
- `Invoke-WebRequest -SkipHttpErrorCheck` 是 PowerShell 7+ 参数。

仓库 `scripts/classmate-install.ps1` 已按这两个坑做过兼容处理。

---

## 八、Caddy + 真实域名 + reverse SSH 的经验仍然有效

2026-09-09 最终稳定过的架构：

```text
ChatGPT
  → https://mcp.sotalabs.cn/mcp
  → Caddy on relay
  → 127.0.0.1:17676
  → reverse SSH
  → local 127.0.0.1:7676
```

公开中转入口：

```text
sotalabs.cn
43.172.80.106
```

域名/IP 本身不是凭据。中转账号应该是受限用户，不给 shell/root：

```text
restrict,port-forwarding,permitlisten="127.0.0.1:17677",no-agent-forwarding,no-x11-forwarding,no-user-rc
```

### Cloudflare Quick Tunnel

优点：最快验证本地 MCP 是否能工作。

缺点：随机域名会变，OAuth issuer/publicBaseUrl 一起跟着变，长期维护差。

### Clash TUN + fake-ip

如果 `dig` 返回 `198.18.x.x`，先想到 fake-ip，而不是真 DNS。

只加 `DIRECT` 规则并不一定够；mihomo/Clash 的 TUN + fake-ip 场景还需要把目标域名从 fake-ip 中排除。详细见 `../clash-direct-routing/SKILL.md`。

---

## 九、2026-09 新增：OpenAI Secure MCP Tunnel

如果目标只是让 **ChatGPT / Codex / Responses API** 调用私有 MCP，先评估官方 Secure MCP Tunnel。

官方架构：

```text
private MCP server
       ↑ local HTTP/stdio
 tunnel-client
       ↓ outbound HTTPS only
 OpenAI-hosted tunnel endpoint
       ↓
 ChatGPT / Codex / Responses API
```

它不要求本地 MCP 开公网入站端口。`tunnel-client` 从内网主动访问 OpenAI。

当前官方要求包括：

- Platform 中创建 `tunnel_id`
- `tunnel-client` runtime API key
- Tunnels Read/Use（创建/编辑还需要 Manage）
- ChatGPT developer-mode 权限与 Platform tunnel 权限是两套权限

选择建议：

| 目标 | 优先方案 |
|---|---|
| 仅 OpenAI 产品使用，允许 Platform tunnel | Secure MCP Tunnel |
| ChatGPT + Claude + 多种第三方 client 共用 | 自建 HTTPS + auth + reverse tunnel |
| 临时验证 | Quick Tunnel |
| 需要完全控制公网入口/审计/域名 | Caddy + 自有域名 |

不要因为已经搭过 Caddy 就默认永远继续堆公网基础设施；也不要因为官方 tunnel 存在就删掉跨厂商方案。两者解决的问题不同。

---

## 十、最终排障顺序

遇到“昨天能用，今天不能用”时，按这个顺序：

```text
1. 本地 MCP 进程活着吗？
2. 本地 /mcp 能响应吗？
3. reverse tunnel / tunnel-client 活着吗？
4. relay loopback port 有监听吗？
5. 公网 FQDN TLS 正常吗？
6. ChatGPT 请求有没有到服务端？
7. protected-resource / authorization-server metadata 正常吗？
8. client_id 属于当前 issuer 吗？
9. refresh token / offline_access 是否有效？
10. 最后才考虑删掉并重新创建 ChatGPT app/connector。
```

**重新添加连接应当是诊断后的动作，不应该是第一反应。**

---

## 十一、多人共用中转服务器

原则保持不变：

- 每人独立子域名
- 每人独立 relay port
- 每人独立受限 SSH user
- 私钥由使用者自己生成，只交公钥
- `GatewayPorts no`
- `permitlisten` 锁定端口

配套脚本：

- `scripts/add-mcp-user.sh`
- `scripts/classmate-install.sh`
- `scripts/classmate-install.ps1`
- `scripts/setup-for-classmate.md`

公开仓库不放任何 owner token、API key、SSH 私钥或 OAuth client secret。
