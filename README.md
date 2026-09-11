# skills-public

公开可分享的 skill 集合。每个子目录一个 skill，内含 `SKILL.md`（带 frontmatter 的 name / description）。

内容都是实战踩坑记录 —— 记**判据**（看到什么现象说明是什么问题）和**被推翻的假设**，而不只是最终答案。

## 目录

| Skill | 说明 |
|---|---|
| [chatgpt-remote-mcp](chatgpt-remote-mcp/SKILL.md)<br>[scripts/](chatgpt-remote-mcp/scripts/) | 2026-09-11 维护版 Remote MCP runbook。覆盖 `does not implement OAuth` 多根因诊断树、`invalid_client` / owner credential / authorization expired、DevSpace OAuth SQLite 持久化、`DEVSPACE_TRUST_PROXY`、MCP 2026-07-28 的 DCR→CIMD 迁移、refresh token / `offline_access`、OpenAI Secure MCP Tunnel、Caddy + reverse SSH 与开机保活。`scripts/` 保留多人共用中转机的安装/开户脚本。 |
| [playwright-remote-mcp](playwright-remote-mcp/SKILL.md) | 把官方 `@playwright/mcp` 独立部署为远程浏览器 MCP。重点解释 Playwright MCP ≠ OAuth gateway ≠ shell/files MCP ≠ CUA；包含 `:8931/mcp`、公网 auth gateway、`invalid_client`、authorization request 过期、HTTP heartbeat/session、独立 FQDN/relay port、浏览器 profile 与四级验收。 |
| [clash-direct-routing](clash-direct-routing/SKILL.md) | 在 Clash Verge / mihomo 的 TUN + fake-ip 模式下让某个域名真正直连。含「只加 DIRECT 规则不生效、必须同时写 `fake-ip-filter`」的根因、如何认准当前生效的那个 script 文件、热重载方式，以及 TUN 开着时 `nc -z`/`dig`/`curl --interface` 全给假信号的判据。 |

## 2026-09-11 之后的几个总原则

- **错误文案不是根因。** `does not implement OAuth` 既可能是 ChatGPT 根本没请求服务端，也可能是真的 discovery 没实现；先看服务端有没有收到请求。
- **状态要分层。** OAuth client/token、owner approval、MCP HTTP session、浏览器 cookie/profile 是不同状态库。
- **能力要拆开。** shell/files MCP、Playwright MCP、CUA 最好独立进程、端口、隧道和身份，不要为了“一个入口”强行耦合。
- **重启不等于重配。** DevSpace 已验证 OAuth 状态持久化；自建 OAuth wrapper 则必须自己确认 client registry/transaction/token 是否持久化。
- **优先评估官方路径。** 只服务 OpenAI 产品时，可先看 Secure MCP Tunnel；跨 ChatGPT/Claude/其他 client 时，自建 HTTPS + auth + tunnel 仍然有价值。

## 关于示例值

- **`sotalabs.cn` / `43.172.80.106` 是真实的中转入口**，脚本里的默认值可以直接用
  （前提是管理员给你开过账号；没开过的话域名不会有对应站点，Caddy 会拒握手）。
- `198.51.100.10` —— RFC 5737 文档专用地址，仅作为占位示例。
- `/Users/<you>`、`relay-admin`、`tmpl-xxxxxxxx`、`ins-xxx` —— 显式占位符，按自己的环境替换。

不含任何活凭据：没有私钥、owner password、API key、refresh token、cookie 或他人的公钥。
中转服务器上每个用户应使用独立受限账号（`restrict` + `permitlisten` 锁单端口、无 shell）。
