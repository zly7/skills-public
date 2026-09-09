# 把你的 Mac 接到 ChatGPT（用别人的服务器做入口）

配好之后，你可以在 **ChatGPT 网页端**让它直接读写你 Mac 上的文件、跑命令——用的是网页端额度，不烧 API。

原理：你 Mac 在 NAT 后面没有公网 IP，所以借一台有公网 IP 和域名的服务器做入口，
你的 Mac 主动连出去建一条反向隧道。

```
ChatGPT → https://mcp-你的名字.yourdomain.cn/mcp
   → 中转服务器 Caddy（TLS 终止，证书自动签发+续期）
   → SSH 反向隧道
   → 你 Mac 上的 DevSpace
```

---

## 第 0 步：生成密钥，把公钥发给管理员

**先做这步**，管理员要用你的公钥才能给你开账号。

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mcp_relay -N "" -C "$(whoami)@$(hostname)-mcp"
cat ~/.ssh/mcp_relay.pub
```

把 **`cat` 出来的那一行**（以 `ssh-ed25519` 开头）发给管理员。

⚠️ 只发 `.pub` 那个文件的内容。`~/.ssh/mcp_relay`（不带 `.pub`）是私钥，**永远不要发给任何人**。

管理员会回给你四个值：SSH 用户名、隧道端口、你的域名、服务器 IP。

---

## 第 1 步：安装

### 方式 A：有 Claude Code / Codex 的，直接把下面这段发给它

> 帮我在这台 Mac 上配置 DevSpace MCP，让 ChatGPT 网页端能通过一台中转服务器控制我的电脑。
>
> 我已有的信息：
> - SSH 用户名：`mcp-你的名字`
> - 隧道端口：`17677`
> - 我的域名：`mcp-你的名字.yourdomain.cn`
> - 服务器 IP：`203.0.113.20`
> - SSH 私钥已在 `~/.ssh/mcp_relay`（公钥已交给管理员，服务器侧已开通）
>
> 请完成：
> 1. `npm install -g @waishnav/devspace`（需要 node >=22.19 <27）
> 2. 写 `~/.devspace/config.json`：`host` 127.0.0.1、`port` 7676、`allowedRoots` 设为我的家目录、`publicBaseUrl` 设为 `https://我的域名`。不要跑 `devspace init`（那是交互式 TUI），改为直接调用 DevSpace 自己的 `dist/user-config.js` 里的 `writeDevspaceConfig` / `writeDevspaceAuth` / `generateOwnerToken` 来写，保证格式一致；`auth.json` 里的 `ownerToken` 如果已存在就复用，并把它打印给我
> 3. 在 `~/.ssh/config` 加一个 `Host mcp-relay`，用上面的 IP、用户名和 `~/.ssh/mcp_relay` 私钥
> 4. 建两个 launchd（都要 `RunAtLoad` + `KeepAlive`，日志写到 `~/.devspace/logs/`）：
>    - `com.mcp.tunnel`：`/usr/bin/ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:<隧道端口>:127.0.0.1:7676 mcp-relay`（🔴 `-R` 必须写成 `127.0.0.1:端口:...` 的完整形式，只写 `端口:` 会被服务器的 `permitlisten` 拒绝，报 `remote port forwarding failed`）
>    - `com.mcp.devspace`：用 node 绝对路径跑 devspace 的 `dist/cli.js serve`
>    注意 launchd 的 PATH 极简，plist 里所有路径都要写绝对路径
> 5. 验证：本地 `127.0.0.1:7676/mcp` 和公网 `https://我的域名/mcp` 都应返回 **401**（401 = 通了但需鉴权；502 = 隧道没起来）
>
> 完成后把 Owner 密码告诉我。

### 方式 B：自己跑脚本

把管理员给的四个值填进 `classmate-install.sh` 顶部，然后：

```bash
chmod +x classmate-install.sh && ./classmate-install.sh
```

或者不改文件，直接用环境变量：

```bash
MCP_USER=mcp-你的名字 MCP_PORT=17677 \
MCP_FQDN=mcp-你的名字.yourdomain.cn MCP_SERVER_IP=203.0.113.20 \
./classmate-install.sh
```

---

## 第 2 步：在 ChatGPT 里添加

1. 设置 → Apps → Advanced settings → 打开 **Developer mode**
2. 设置 → Connectors → **Create**
3. 填：

| 字段 | 值 |
|---|---|
| 名称 | 随便，比如 `我的Mac` |
| 连接 | 保持 **服务器 URL**（不要切到「隧道」） |
| MCP server URL | `https://mcp-你的名字.yourdomain.cn/mcp` |
| 身份验证 | **OAuth** |
| ☐ 我了解并希望继续 | 勾上 |

4. 连接时会跳出授权页要 **Owner 密码**：

```bash
cat ~/.devspace/OWNER_PASSWORD.txt
```

---

## 排错

**先看这两个数字，能定位到是哪一段断的：**

```bash
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7676/mcp -X POST -d '{}'   # 本地
curl -o /dev/null -w "%{http_code}\n" https://mcp-你的名字.yourdomain.cn/mcp          # 公网
```

| 本地 | 公网 | 说明 |
|---|---|---|
| 401 | 401 | ✅ 全通，问题在 ChatGPT 侧 |
| 401 | 502 | 隧道断了 → `launchctl kickstart -k gui/$(id -u)/com.mcp.tunnel` |
| 失败 | 502 | DevSpace 没起 → 看 `~/.devspace/logs/serve.err` |

**「刚刚还能用，现在连不上」** —— 这是最常见的情况，八成是 **DevSpace 重启了**。它的 OAuth 授权全存在内存里（`~/.devspace/` 下没有任何数据库文件），进程一重启，ChatGPT 那边的授权就作废，但进程本身是活的，所以看起来一切正常。

```bash
ps -o pid,lstart,etime -p $(pgrep -f "devspace.*serve" | head -1)
```

启动时刻如果晚于你上次成功用它的时间 —— 就是它。**去 ChatGPT 里把 connector 删掉重加一次**即可。

**Mac 睡眠 = 断线。** 隧道会断，ChatGPT 立刻用不了；唤醒后 launchd 会自动重连，但可能要重新授权。要长期挂着就别让它休眠。

---

## 几件你应该知道的事

- **ChatGPT 能看到什么**：`allowedRoots` 设成了你的家目录，也就是说它能读写 `~` 下的一切——包括 `~/.ssh` 里的私钥、各种配置文件里的 token。想收窄就改 `~/.devspace/config.json` 里的 `allowedRoots`（比如只给某个项目目录），然后 `launchctl kickstart -k gui/$(id -u)/com.mcp.devspace`。
- **流量经过别人的服务器**：Caddy 到隧道之间是明文 HTTP，你的文件内容和命令输出会明文经过中转服务器。服务器管理员在技术上是能看到的。
- **带宽是共享的**：出网 30 Mbps 大家一起用，别让 ChatGPT 去读几百 MB 的文件，会把所有人卡住。流量套餐 1536 GB/月，超了是管理员付钱。
- **你的账号只能建隧道**：SSH 登录会提示 `This account is currently not available`，这是正常的——账号被限制成没有 shell、且只能转发分配给你的那一个端口。
