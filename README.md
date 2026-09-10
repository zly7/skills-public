# skills-public

公开可分享的 skill 集合。每个子目录一个 skill，内含 `SKILL.md`（带 frontmatter 的 name / description）。

内容都是实战踩坑记录 —— 记**判据**（看到什么现象说明是什么问题）和**被推翻的假设**，而不只是最终答案。

## 目录

| Skill | 说明 |
|---|---|
| [chatgpt-remote-mcp](chatgpt-remote-mcp/SKILL.md)<br>[scripts/](chatgpt-remote-mcp/scripts/) | 把本地机器通过远程 MCP 接到 ChatGPT/Claude 网页端，用网页端额度驱动本地干活。含 ChatGPT 对 URL 的隐藏校验规则（裸 IP 和 sslip.io 会被拒，报错却是误导性的 "does not implement OAuth"）、中国大陆 ICP 备案拦截的实测边界、Let's Encrypt 在境内服务器上的签发路径、DevSpace 配置、macOS 两层权限（allowedRoots + TCC）、反向隧道与 launchd 保活。`scripts/` 是多人共用一台中转服务器的成套脚本：管理员开户、使用者一键安装、以及可直接粘给 AI 的提示词 |
| [clash-direct-routing](clash-direct-routing/SKILL.md) | 在 Clash Verge / mihomo 的 TUN + fake-ip 模式下让某个域名真正直连。含「只加 DIRECT 规则不生效、必须同时写 `fake-ip-filter`」的根因、如何认准当前生效的那个 script 文件、热重载方式，以及 TUN 开着时 `nc -z`/`dig`/`curl --interface` 全给假信号的判据 |

## 关于示例值

- **`sotalabs.cn` / `43.172.80.106` 是真实的中转入口**，脚本里的默认值可以直接用
  （前提是管理员给你开过账号；没开过的话域名不会有对应站点，Caddy 会拒握手）。
- `198.51.100.10` —— RFC 5737 文档专用地址，代表「某台境内服务器」，仅用于讲备案拦截。
- `/Users/<you>`、`relay-admin`、`tmpl-xxxxxxxx`、`ins-xxx` —— 显式占位符，按自己的填。

**端口号、错误码、状态码、价格、命令参数、TTL 都是实测真值**，可以直接照抄。

不含任何凭据：没有私钥、没有 API 密钥、没有他人的公钥。
中转服务器上每个用户是独立的受限账号（`restrict` + `permitlisten` 锁死单个端口、无 shell），
知道域名和 IP 不等于能连上。
