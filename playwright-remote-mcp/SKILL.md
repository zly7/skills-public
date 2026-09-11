---
name: playwright-remote-mcp
description: 远程部署官方 @playwright/mcp，并通过 ChatGPT/Claude/Codex 使用浏览器自动化。解释 Playwright MCP 与 shell/files MCP、CUA 的职责边界，HTTP /mcp 端点、OAuth gateway、invalid_client、authorization expired、持久浏览器上下文、反向隧道和安全边界。当 Playwright 本地能跑但 ChatGPT 连接失败时使用。
---

# Playwright Remote MCP：2026-09-11 实战版

目标：把浏览器自动化能力独立作为一个 MCP server 暴露，而不是把 Playwright 嵌进 DevSpace、shell MCP 或 CUA。

官方项目：

- https://github.com/microsoft/playwright-mcp

当前官方 standalone 用法：

```bash
npx @playwright/mcp@latest --port 8931
```

HTTP MCP endpoint：

```text
http://127.0.0.1:8931/mcp
```

Playwright 官方明确提醒：**Playwright MCP 不是安全边界。** 如果要跨公网暴露，必须额外做认证、入口限制和传输保护。

---

## 一、先分清三种能力

```text
shell/files MCP
    → 文件、命令、项目、系统操作

Playwright MCP
    → 浏览器 DOM / accessibility tree / 页面交互

CUA / computer use
    → 视觉、鼠标、键盘、桌面 GUI
```

它们可以同时存在，但应该：

- 独立进程
- 独立本地端口
- 独立 relay port
- 独立公网 FQDN（公网自建时）
- 独立认证状态

不要为了“看起来只有一个 MCP”而把三个服务强行套在一起。

---

## 二、官方 Playwright MCP 本身可以直接开 HTTP transport

典型：

```bash
npx @playwright/mcp@latest \
  --port 8931
```

如果确实要让其他机器直接访问本地服务，可以显式 host：

```bash
npx @playwright/mcp@latest \
  --host 0.0.0.0 \
  --port 8931
```

但公网场景**不要直接把 8931 暴露到 Internet**。更安全的是：

```text
Playwright MCP 127.0.0.1:8931
        ↑
reverse tunnel / private tunnel
        ↑
TLS + auth gateway
        ↑
ChatGPT
```

本地先验收：

```bash
curl -i http://127.0.0.1:8931/mcp
```

不要要求普通 GET 一定返回 200；MCP endpoint 可能根据 transport / method 返回 4xx。关键是**进程在监听，并且请求确实到达 Playwright MCP**。

---

## 三、最大的架构误区：`@playwright/mcp --port` 不等于“自动满足 ChatGPT OAuth”

官方 Playwright MCP 提供 MCP transport 和浏览器工具，但不要假设：

```text
开了 8931
= 自动有 OAuth discovery
= ChatGPT 公网地址可直接添加
```

如果 ChatGPT 的 app/connector 要求 OAuth，而前面只是原生 Playwright MCP，就可能出现：

```text
MCP server https://.../mcp does not implement OAuth
```

此时先看公网入口日志：

- ChatGPT 根本没请求到 → URL/DNS/TLS/客户端预检层。
- `/.well-known/...` 请求到了并返回 404 → 确实缺 OAuth discovery/gateway。
- OAuth 已开始 → 进入 client/issuer/state 排查。

因此公网结构通常是：

```text
ChatGPT
  ↓ HTTPS
OAuth / auth gateway
  ↓
Playwright MCP :8931
```

或者只服务 OpenAI 时评估 Secure MCP Tunnel，避免自己公开入口。

---

## 四、2026-09-11 实测最值得记的四个错误

### 1. `does not implement OAuth`

含义不唯一。先判断请求有没有真正打到 server，再决定查 URL 还是 OAuth metadata。

### 2. `invalid_client`

典型解释：ChatGPT 带来的 `client_id` 不被当前 authorization server 承认。

重点检查：

```text
OAuth wrapper 是否重启后丢失 client registry？
当前域名和 issuer 是否变化？
是否把另一个 Playwright 实例的 client_id 拿来复用？
不同 FQDN 是否实际路由到不同 OAuth store？
```

如果 wrapper 的 client registry 只在内存里，重启后旧 `client_id` 就可能立刻失效。

### 3. `Incorrect owner credential`

说明 OAuth flow 已经走到了 owner approval / 应用管理层。

这与 Playwright MCP 本身是否能 `browser_navigate` 是两件事。

检查：

- 当前进程加载的 owner credential 来源
- service manager 的环境变量
- 配置文件是不是另一用户/另一工作目录
- 重启后是否重新生成了 owner credential

### 4. `Authorization request expired. Reconnect from ChatGPT.`

不要刷新旧授权页反复提交。

正确做法是从 ChatGPT 重新发起连接，拿到新的 authorization request。

如果新请求立即过期，查：

```bash
date -Is
```

以及：

- auth transaction TTL
- server clock/NTP
- 多实例是否共享 transaction store
- 反代是否把 authorize 和 approve 请求分到不同实例

---

## 五、每个 Playwright 实例必须拥有自己的身份

推荐：

```text
machine A
  Playwright :8931
  OAuth gateway :8933
  relay :17xxx
  FQDN playwright-a.example.com

machine B
  Playwright :8931
  OAuth gateway :8933
  relay :17yyy
  FQDN playwright-b.example.com
```

**本地端口可以相同，relay port 和公网域名必须能唯一定位实例。**

不要：

```text
两个机器共用同一个公网 FQDN
→ gateway 随机路由
→ client registration/state 不共享
→ intermittent invalid_client / expired request
```

如果要做 HA，就必须把 OAuth client、authorization transaction、token 状态放到共享持久化存储，而不是各进程内存。

---

## 六、浏览器 profile / session 与 OAuth session 是两套状态

不要混淆：

```text
ChatGPT ↔ OAuth gateway 的授权状态
```

和：

```text
Playwright ↔ Chrome 的登录/cookie/profile 状态
```

它们分别决定：

- ChatGPT 有没有权调用工具
- 浏览器有没有登录目标网站

Playwright 当前提供和持久上下文相关的选项，例如 `--shared-browser-context`、用户数据目录/存储状态等。具体 flag 以当前 `@playwright/mcp@latest --help` 为准。

升级包后先执行：

```bash
npx @playwright/mcp@latest --help
```

不要根据几个月前 README 硬编码所有 flag。

---

## 七、HTTP session heartbeat 也是远程链路的一个坑

Playwright 官方文档目前说明，HTTP sessions 有 heartbeat timeout；代理如果不正确处理 server-initiated ping，可能造成 session 被回收。

当前可检查环境变量：

```bash
PLAYWRIGHT_MCP_PING_TIMEOUT_MS
```

出现这种症状时要想到 heartbeat/session，而不是 OAuth：

```text
第一个 browser_navigate 成功
等几秒
第二个工具调用 Session not found / context 重建
```

先用最新版重现；旧版本曾有过 Streamable HTTP session/heartbeat 相关 bug。

---

## 八、反向隧道推荐结构

```text
Caddy :443
 ↓
OAuth gateway loopback port
 ↓
SSH reverse tunnel
 ↓
local OAuth gateway
 ↓
127.0.0.1:8931 Playwright MCP
```

如果 gateway 和 Playwright MCP 都在本机，公网只需要暴露 gateway，不需要同时给 8931 一个公网入口。

受限 SSH 用户时：

```bash
ssh -N \
  -R 127.0.0.1:<relay-port>:127.0.0.1:<gateway-port> \
  <relay-host>
```

**不要把 reverse tunnel 直接落到 Playwright 8931，然后期待它凭空多出 OAuth。**

---

## 九、验收不要只测“能连接”

至少做四级验收：

### L1 进程

```bash
ps aux | grep -E 'playwright.*mcp'
ss -lntp | grep 8931
```

### L2 本地 MCP

确认 localhost 请求能到 server。

### L3 ChatGPT OAuth / tool discovery

确认 ChatGPT 能完成连接，能看到 Playwright tools。

### L4 真浏览器动作

至少执行：

```text
打开 example.com
读取页面标题
在一个普通输入框输入测试文本
点击一个无副作用按钮/链接
```

只有 L4 成功，才能说“Playwright 远程操控跑通”。

---

## 十、安全边界

浏览器里可能存在：

- 登录态
- 邮件/社交账号
- 云控制台
- 支付信息
- GitHub session
- 内网页面

因此：

1. 不要裸露 8931 到公网。
2. OAuth/gateway 不能只靠一个可猜密码。
3. relay 上只给 reverse-forward 权限，不给 shell/root。
4. 不同使用者最好使用不同 browser profile / OS user。
5. 对 destructive actions 保留人工确认。
6. 不要把 owner password、cookie、refresh token 写进公开仓库。

---

## 十一、最短排障表

| 现象 | 第一检查点 |
|---|---|
| ChatGPT `does not implement OAuth` | 服务端有没有收到 `/.well-known` 请求 |
| `invalid_client` | client registry 是否持久化、issuer 是否一致 |
| `Incorrect owner credential` | gateway 当前加载的 owner credential |
| `Authorization request expired` | 重新发起 auth request；再查 clock/TTL/store |
| tools 能看到但浏览器没反应 | Playwright 进程/浏览器/display/profile |
| 第一次调用成功，第二次 session 丢 | HTTP heartbeat / session timeout / proxy |
| 公网 502 | reverse tunnel / relay loopback port |
| 本地 8931 正常，ChatGPT 不行 | auth gateway / public metadata，而不是 Playwright 本体 |

核心原则：**Playwright MCP 负责浏览器；OAuth gateway 负责谁能调用；tunnel 负责怎么到达。三者不要混为一谈。**
