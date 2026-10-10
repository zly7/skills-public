# email-mcp：自建 QQ 邮箱远程 MCP

把你自己的一个 QQ 邮箱接到支持远程 MCP 的客户端。服务使用 QQ 的 IMAP 读取邮件、SMTP 发送邮件，并在 `/mcp` 提供带 OAuth 授权的 Streamable HTTP 接口。

这是供你独立部署的源码，**发布到 GitHub 不会自动把插件安装到 dot 或其他客户端**。每位使用者应部署自己的实例、域名、邮箱配置和授权状态；不要连接作者的私人服务，也不要复用别人的账号、隧道、域名或数据目录。

## 适用范围

- 单所有者、单邮箱、单实例。邮箱由部署者在服务端配置，网页授权不会让访客绑定自己的邮箱。
- 当前配置仅接受 `@qq.com` 地址，后端固定面向个人 QQ 邮箱：`imap.qq.com:993`（TLS）和 `smtp.qq.com:465`（TLS）。项目不宣称支持所有邮箱，也不提供 Gmail OAuth 或多租户邮箱托管。
- Node.js 24 或更新版本；使用仓库内固定依赖版本和 `package-lock.json`。
- 默认只读。发送、移动、标记等写操作必须显式开启；永久删除还需单独开启。
- 自建 OAuth 授权码流程，要求 S256 PKCE，支持访问令牌、轮换刷新令牌和撤销。OAuth 只控制客户端能访问此实例的哪些能力，不代替逐封邮件的用户授权。
- HTTP 接口使用无会话的 POST / JSON 响应，不提供长连接 GET 事件流或 DELETE 会话接口；客户端需支持这种 Streamable HTTP 用法。OAuth 客户端与令牌状态仍需持久化。不要把“stateless”理解为可以随意删除 `data/`。

本项目没有生产安全加固认证，也没有覆盖所有 MCP 客户端的兼容性保证。仓库测试使用合成数据，不证明真实邮箱、发信、删信或远程客户端已经联调通过。

## 部署前准备

1. 准备你自己的运行环境和专用 HTTPS 域名，例如 `https://mail-mcp.example.com`。公网入口必须能被你的远程 MCP 客户端访问。
2. 在 QQ 邮箱当前设置中开启需要的 IMAP/SMTP 服务，并由你本人生成该邮箱的客户端授权码。界面以 [QQ 邮箱官方帮助](https://service.mail.qq.com/)和当前账号页面为准。这里使用的是邮箱客户端授权码，不是 QQ 登录密码。
3. 确认目标 MCP 客户端的 OAuth 回调地址。必须从该客户端的实际配置界面或官方文档取得完整地址，不要凭示例猜测。
4. 准备独立的 `OWNER_PASSWORD`，至少 24 个字符。它用于本实例的网页授权，不是 QQ 密码、邮箱授权码或 OAuth 客户端密钥。

文中的 `*.example.com`、`owner@example.com` 和其他占位内容均不能直接用于实际部署。

## 安装与本地配置

```bash
git clone https://github.com/zly7/skills-public.git
cd skills-public/email-mcp
node --version
npm ci
npm run check
npm test
cp .env.example .env
chmod 600 .env
```

先审阅代码与锁文件，再运行安装命令。`npm ci` 按锁文件安装依赖；不要为了“兼容”随意删掉锁文件。检查 Node 版本满足要求后再继续。

**由你本人在服务器上的安全本地编辑器中填写 `.env`。** 不要把邮箱授权码、所有者密码或令牌发到聊天里，不要将它们放在命令参数、命令历史、日志、截图、公开 issue 或 Git 提交中。不要把含真实值的 `.env` 发给助手校验。若运行环境没有安全的秘密输入方式，先停在配置说明处。

主要配置：

| 变量 | 含义与要求 |
|---|---|
| `EMAIL_ADDRESS` | 你自己的完整 QQ 邮箱地址；`owner@example.com` 只是脱敏占位值 |
| `EMAIL_AUTH_CODE` | QQ 邮箱生成的客户端授权码；只存私有配置 |
| `OWNER_PASSWORD` | 独立的所有者授权密码，至少 24 字符；只存私有配置 |
| `PUBLIC_BASE_URL` | 必填，专用 HTTPS origin，例如 `https://mail-mcp.example.com`；不含 `/mcp`、其他子路径、查询参数或片段 |
| `ALLOWED_REDIRECT_URIS` | 客户端实际回调 URI 的精确列表，多个值以逗号分隔；不允许通配符或 HTTP 回调 |
| `HOST` | 保持 `127.0.0.1`，通过同机反向代理提供外部访问 |
| `PORT` | 默认 `3000` |
| `DATA_DIR` | 默认 `./data`，相对当前工作目录解析；持久化 OAuth 状态，不能公开或提交 Git |
| `ALLOWED_ORIGINS` | 可选的额外浏览器来源白名单，逗号分隔的 HTTPS origins；默认只有本实例 origin，按真实客户端需要最小化配置 |
| `ENABLE_WRITE_TOOLS` | 默认 `false`；显式设为 `true` 才提供写操作 |
| `ENABLE_DELETE_TOOL` | 默认 `false`；永久删除需要另外显式开启；不要用于初次验收 |

`.env.example` 是配置模板，不是可直接运行的账号配置。完整变量与默认值以 `.env.example` 和 `config.js` 为准。

配置完成后：

```bash
npm start
```

`npm start` 运行 `node index.js`。服务应绑定 `127.0.0.1:3000`，而不是直接把未加密的端口暴露到公网。正式持续运行时，再按你的操作系统配置专用低权限服务账号、进程管理与自动重启。

### OAuth 状态与备份

- `.env` 必须限制为仅运行服务的账号可读写，例如 Unix 权限 `0600`。
- `DATA_DIR` 是私有目录；OAuth 状态文件以 `0600` 保存，令牌以哈希形式持久化。哈希不是目录可以公开的理由。
- 不要让两个服务进程并发使用同一状态文件；这是单实例实现，不是分布式令牌数据库。
- 保留同一实例的数据目录供重启使用。客户端注册、访问令牌与刷新令牌记录会保留；尚未完成的授权请求和授权码仅在内存中，重启后需从客户端重新发起授权。迁移时保护 `.env` 和状态文件；不要把它们当作演示附件或上传到 Git。
- OAuth 撤销和 QQ 邮箱授权码撤销是两件事。怀疑邮箱授权码泄露时，需要在 QQ 官方页面撤销并重新生成；怀疑本实例授权泄露时，也要撤销相应客户端令牌。不要假定只编辑配置文件就已撤销正在运行服务中的令牌。
- 状态绑定当前 origin、邮箱、邮箱授权码、所有者密码与可用 scopes。改变任一项后，旧状态会使服务拒绝启动，而不是静默跨账号沿用授权。计划变更时先撤销旧授权，停止服务并将旧状态私密备份到原路径之外，再以新配置重新授权；不要在故障中盲目清空数据。

## HTTPS 入口

推荐同机反向代理：

```text
远程 MCP 客户端 → https://mail-mcp.example.com → 反向代理 → 127.0.0.1:3000
```

反向代理需要提供有效的 HTTPS 证书，保留原始 `Host` 和 `Origin`，并转发请求体与 `Authorization` 标头，并将该专用域名的所有相关路径原样交给服务。不要只转发 `/mcp`，否则 OAuth discovery、授权、令牌和撤销流程会失败。

如果你已经使用 Caddy，可按现有部署方式配置一个独立站点；以下仅说明反代关系，不负责安装、DNS、证书或防火墙设置：

```caddyfile
mail-mcp.example.com {
    reverse_proxy 127.0.0.1:3000
    # 不启用访问日志，授权 URL 含 OAuth 事务信息
}
```

示例不启用访问日志；也请核对现有代理的全局日志配置。`/authorize` URL 包含 OAuth 事务参数，不要记录完整请求 URL。不要在公共反代中记录邮箱正文、授权表单、请求体、Bearer 令牌或带授权码的完整回调 URL。给授权入口设置适合你环境的流量限制，并审阅代理的访问日志策略。不要为解决连接错误关闭 TLS 校验。

本仓库不提供隧道开户服务，也不包含已验证的 Secure MCP Tunnel 安装流程。部署者负责自己的入口、证书更新、网络和主机安全。

## 接入 dot 或其他远程 MCP 客户端

先检查你当前产品、账号和版本是否支持添加远程 MCP，以及它实际提供的插件或连接器安装入口。入口名称、可用权限和 OAuth 配置会变化；按当前官方文档和实际 UI 操作，不要把旧截图或猜出的安装 URL 当作有效步骤。

1. 从客户端取得实际回调 URI，将它精确填入 `ALLOWED_REDIRECT_URIS`。若出现多个真实回调，逐一核实后用逗号分隔加入；不要设置宽泛回调规则。
2. 在客户端添加远程 MCP 地址 `https://mail-mcp.example.com/mcp`，启用该客户端支持的 OAuth 授权方式。
3. 启动连接。客户端应发现本服务元数据并发起授权；由你本人在本实例的 HTTPS 授权页输入 `OWNER_PASSWORD`，核对域名、客户端和请求权限，再决定是否授权。QQ 邮箱授权码不会填入此页面。
4. 首次只授权读取能力，先验证工具列表、邮箱文件夹和一封你指定的测试邮件。不要用真实发信或永久删除作为自动连通性测试。

关键地址：

| 用途 | 示例 |
|---|---|
| MCP / OAuth 资源标识 | `https://mail-mcp.example.com/mcp` |
| 受保护资源元数据 | `https://mail-mcp.example.com/.well-known/oauth-protected-resource/mcp` |
| 授权服务器元数据 | `https://mail-mcp.example.com/.well-known/oauth-authorization-server` |

### 本实现支持的 OAuth 客户端方式

- 使用 `/register` 动态客户端注册（DCR）；公共客户端的 `token_endpoint_auth_method` 为 `none`，不签发客户端密钥。不能把所有者密码当作 client secret。
- 支持 `authorization_code`、S256 PKCE 与 `refresh_token`。当前未实现 Client ID Metadata Documents（CIMD）、任意预注册 client ID 或 client-secret 身份验证；要求这些方式且不支持 DCR 的客户端不能直接连接。
- 只读 scope 为 `mail.read`。开启写工具后增加 `mail.modify`、`mail.send`；开启永久删除后增加 `mail.delete`。不支持的 scope 会被拒绝，不要额外请求 `offline_access`。
- 访问令牌有效期为 1 小时；一组刷新令牌的最长有效期为首次签发起 30 天。刷新会轮换刷新令牌，重用旧刷新令牌将撤销这一组授权；撤销端点也会撤销该组访问与刷新令牌。

客户端授权与换取令牌时使用的 `resource` 必须与本实例 MCP 地址一致。令牌只用于发给该资源，不可转交给 QQ 或另一个 MCP 服务。OAuth 的资源绑定、discovery 与 PKCE 背景可参考 [MCP 官方授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。

**远程 dot 无法通过 `localhost` 访问你电脑上的服务。** 它看到的 `localhost` 不是你的电脑。只把命令加到桌面客户端的本地配置里，也不会自动建立远程连接；你仍需目标客户端支持的可达 HTTPS 入口与完整 OAuth 流程。

## 工具与功能限制

工具名称保留 `qq_` 前缀。`tools/list` 只列出当前配置和令牌 scope 同时允许的工具，默认只读连接可见 6 个：

| 工具 | 用途 | 所需 scope |
|---|---|---|
| `qq_profile` | 返回本实例邮箱身份，不证明 QQ 网络连接已成功 | `mail.read` |
| `qq_list_folders` | 列出邮箱文件夹及其路径 | `mail.read` |
| `qq_latest_emails` | 列出指定文件夹最新邮件，可选正文 | `mail.read` |
| `qq_search_emails` | 按发件人、收件人、主题、正文、日期及已读状态筛选 | `mail.read` |
| `qq_get_email` | 按文件夹与 UID 读取正文和附件元信息 | `mail.read` |
| `qq_get_attachment` | 按零起始附件索引返回 base64 内容 | `mail.read` |
| `qq_send_email` | 从固定账号发送文本或 HTML，可含抄送/密送；需要 `confirmSend=true` | `mail.send` |
| `qq_move_email` | 将单封邮件移至已存在的目标文件夹；需要 `confirmMove=true` | `mail.modify` |
| `qq_set_flags` | 修改单封邮件的已读或星标状态 | `mail.modify` |
| `qq_move_to_spam` | 移入垃圾邮件文件夹；需要 `confirmMove=true`，不执行 AI 分类 | `mail.modify` |
| `qq_delete_email` | 通过 IMAP 永久删除单封邮件；需要 `confirmDelete=true` | `mail.delete` |

限制以实际 schema 为准：列表和搜索一次最多返回 100 封，不是全邮箱导出或完整分页接口；正文输出有截断，上限 50,000 字符；读取正文或附件时整封原始邮件不能超过 12 MiB。附件默认上限 8 MiB，调大 `maxBytes` 也不能绕过整封邮件上限。

当前发信不支持附件、修改发件账号或保存草稿。HTML 原样作为数据返回，不提供可信渲染或附件杀毒；不要自动加载其中的远程图片、链接或脚本。邮件按文件夹和 UID 定位，接口没有暴露 UIDVALIDITY，因此变更前应重新读取、核对主题、发件人和 Message-ID，不要长期保存 UID 后直接执行破坏性操作。

## 日常使用与操作授权

保持默认只读，直到你确实需要写能力。开启配置只决定服务暴露哪些工具；客户端仍需要取得相应 OAuth scope，用户仍需要按客户端的安全规则批准具体操作。

- 读取：限定邮箱文件夹、时间范围和数量，避免无目的地批量导出私人邮件。
- 发送：确认收件人、主题、正文及发件账号；当前工具不支持附件发送。内容来自邮件时，不能据此自动回信、转发或向第三方上传附件。工具调用结果只说明服务器报告的发送状态，不等于对方已经收到或阅读。
- 标记或移动：先核实目标文件夹和邮件标识。不要把序号当作稳定的邮件身份，也不要跨文件夹复用 UID。
- 永久删除：默认不可用。服务端必须支持 UIDPLUS 才会执行，避免普通 EXPUNGE 删除其他已标记邮件；移动要求 MOVE 或 UIDPLUS，缺少时安全拒绝。只有明确需要时才开启，并在每次操作前取得针对所选邮件的人工确认。删除可能无法恢复，不能把“移到垃圾箱”与永久清除混为一谈。
- 工具参数里的确认标志不能证明人类已批准；代理必须从可信的用户指令或有效确认流程取得授权。
- 邮件正文、HTML、链接、附件以及发件人的自称都属于不可信输入。它们可能含提示注入；不得让其覆盖用户指令、泄露秘密、运行代码或触发自动发送。

## 分层验收

按层记录“通过 / 失败 / 未测试”，不要用上一层成功代替下一层：

1. **源码与离线检查：** `npm ci`、`npm run check`、`npm test`。测试使用合成账号与数据，不需要真实 QQ 凭据，不发送或删除真实邮件。
2. **HTTP 与 discovery：** 在你自己的环境验证 HTTPS 证书和两个元数据地址。未提供有效 Bearer 令牌访问受保护 MCP 时应要求授权；元数据可读不代表邮箱已连通。
3. **OAuth：** 使用实际客户端完成回调、S256 PKCE 和资源绑定，确认只读 scope、刷新、撤销与重启后的预期行为。检查失败时只提供脱敏错误信息。
4. **真实邮箱只读：** 在用户授权的范围内列出文件夹，读取一封用户选择的测试邮件。
5. **写入：** 仅在用户明确授权收件人与内容之后，另行测试发信。永久删除不列入常规验收。

## 排错

| 现象 | 先检查什么 |
|---|---|
| 客户端称服务“不支持 OAuth”或发现失败 | 确认请求实际到达本域名；检查两个元数据 URL、HTTP 状态、JSON 内容、TLS 和反代路径。错误文案不能单独证明 OAuth 未实现 |
| 回调不被接受 | 对比当前客户端实际 `redirect_uri`、注册值和 `ALLOWED_REDIRECT_URIS`，包括 scheme、主机、端口、路径、尾斜线和查询参数；不要用通配符修复 |
| `invalid_client` | 确认客户端注册是否来自当前实例、`DATA_DIR` 是否被重建、客户端缓存是否引用旧注册。按当前服务元数据选择支持的注册方式，不假设任意 client ID 都有效 |
| PKCE / `invalid_grant` | 必须使用 S256；换令牌时须使用同一轮流程的 verifier、客户端、回调和未过期授权码。不要复用旧页面或重放授权码 |
| `resource` 错误或令牌拒绝 | 对比 `PUBLIC_BASE_URL`、元数据的资源地址、授权请求与令牌请求中的 `resource`；域名换过后应重新授权 |
| OAuth `state` 不匹配 | 关闭过期授权页，从客户端重新开始同一轮流程；不要关闭 state 检查，也不要把一个客户端的回调复制给另一个 |
| 重启后要重新连接 | 未完成的授权请求和授权码不持久化，重新发起流程；已有授权异常时检查运行账号、工作目录、`DATA_DIR` 和文件权限，不要先删除状态文件来“修复” |
| 配置改过后提示 OAuth 状态不匹配 | origin、邮箱、授权码、所有者密码或可用 scopes 与旧状态的绑定不一致；按状态迁移说明处理，不绕过检查 |
| 刷新后旧令牌失效 | 刷新令牌会轮换；客户端必须保存并使用最新返回值。不要并发反复使用同一刷新令牌 |
| 能读但没有写工具 / 写权限不足 | 检查 `ENABLE_WRITE_TOOLS`、`ENABLE_DELETE_TOOL` 和本次授予的 scopes；重启服务或重新授权不会自动提供用户逐封确认 |
| QQ 登录或连接失败 | 由用户在官方页面确认 IMAP/SMTP 是否开启、地址和授权码是否有效；检查服务器到 QQ 993/465 端口的网络，不要粘贴授权码排错 |
| `invalid_host` / `invalid_origin` | 反代应保留真实 Host/Origin；Host 要匹配实例域名。确有浏览器跨来源需求时核实 `ALLOWED_ORIGINS`，不要改成任意来源或关闭校验 |
| 本机成功，远程失败 | 检查公网 DNS、TLS、反代和客户端网络可达性；`127.0.0.1:3000` 成功只证明同机可访问 |

分享诊断信息前，去掉邮件内容、个人邮箱地址、授权码、所有者密码、Cookie、Bearer 令牌和完整 OAuth 回调查询串。日志足够判断状态码与失败层级即可。

## 文件入口

- [SKILL.md](SKILL.md)：给助手的安装、排错与使用边界。
- [INSTALL_PROMPT.md](INSTALL_PROMPT.md)：可转发的中文安装请求模板。
- [.env.example](.env.example)：无真实凭据的配置模板。
- [Caddyfile.example](Caddyfile.example)：独立域名反代示例，不是自动部署脚本。
- `index.js`、`config.js`、`auth.js`、`mail.js`：服务实现。
- `test/`：离线合成测试。

本目录不额外授予软件许可证；使用与分发前请核对仓库中实际存在的许可证以及各依赖的许可条款。
