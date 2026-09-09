---
name: clash-direct-routing
description: 在 Clash Verge / mihomo 的 TUN + fake-ip 模式下，让某个域名或 IP 真正绕过代理直连。含「只加 DIRECT 规则不生效」的根因、改哪个脚本文件才算数、热重载方式，以及 TUN 开着时各种连通性探测会给出假信号的判据。当遇到 SSL_ERROR_SYSCALL / 连不上自己服务器 / 需要让内网或自建服务器走直连时使用。
---

# 让某个域名在 Clash 里真正直连

2026-09-09 实战。环境：macOS + Clash Verge Rev（内核 mihomo），**TUN 模式 + fake-ip**。

目标：让 `mcp.yourdomain.cn` 绕过代理直连——它指向的是自建的境外服务器，
而那台服务器上同时跑着自己的代理节点，绕一圈套两层没有意义。

---

## 🔴 一、只加 DIRECT 规则**不生效**

这是最大的坑。加了 `DOMAIN-SUFFIX,yourdomain.cn,DIRECT` 之后照样连不上，
表现是 `curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL` 这种**看起来像 TLS 故障**的假象。

根因：fake-ip 模式下 DNS 先返回 `198.18.x.x` 的**假地址**，
DIRECT 规则拿着假 IP 出不去，SNI 和路由全乱。

**必须同时改两处**：

| 改哪 | 作用 |
|---|---|
| `dns.fake-ip-filter` 加上该域名 | 让它走真实 DNS 解析，不发假 IP |
| `rules` 最前面插 DIRECT | 让流量真的走直连出口 |

⚠️ 很多订阅的原始配置里**根本没有 `fake-ip-filter` 这个键**，要新建，不是修改。
判断方法：`grep -n 'fake-ip-filter' clash-verge.yaml`，没输出就是没有。

---

## 🔴 二、改哪个脚本才算数（今天在这里白改过一轮）

Clash Verge 的每个订阅（profile）各自绑一条增强链：merge / script / rules / proxies / groups。
`profiles/` 目录下会躺着**好几个** `.js`，属于不同订阅。**改到没在用的那个，等于没改。**

正确的定位顺序：

```bash
D=~/Library/Application\ Support/io.github.clash-verge-rev.clash-verge-rev

# 1. 当前生效的 profile uid
grep -E '^current:' "$D/profiles.yaml"

# 2. 找到它的 option.script —— 这才是要改的文件
grep -n -A22 'uid: <上一步的uid>' "$D/profiles.yaml" | grep 'script:'
```

我第一次直接去改 `profiles/` 里翻到的第一个 `.js`，它绑在另一个**没启用**的订阅上，而当前生效的订阅用的是另一个脚本文件——改了半天毫无反应。

🔴 另外：`Merge.yaml` 里的 `prepend-rules` 在这个 Verge 版本**无效**（早年注释里记过），
规则注入只能走 script。

---

## 三、脚本怎么写

```js
function main(config, profileName) {
  const SUFFIX = "yourdomain.cn";
  const SERVER = "203.0.113.20/32";

  // ① fake-ip-filter：让它走真实解析。原始配置可能没有这个键，要新建。
  config.dns = config.dns || {};
  const filter = config.dns["fake-ip-filter"] || [];
  config.dns["fake-ip-filter"] = [...new Set([...filter, `+.${SUFFIX}`, SUFFIX])];

  // ② 规则必须插到最前面，否则被订阅自带的兜底规则先吃掉。
  //    先 filter 掉同名规则再拼，保证脚本可重复执行不叠加。
  const mine = [
    `DOMAIN-SUFFIX,${SUFFIX},DIRECT`,
    `IP-CIDR,${SERVER},DIRECT,no-resolve`,
  ];
  const rest = (config.rules || []).filter((r) => !mine.includes(r));
  config.rules = [...mine, ...rest];

  return config;
}
```

`IP-CIDR` 那条要加 `no-resolve`，否则匹配 IP 规则时会触发一次 DNS 解析，绕回去。

**关于作用域**：别无脑把整个域名后缀设直连。我这次差点踩到——
`yourdomain.cn` 下面除了 MCP 入口，还挂着 Clash 自己的订阅地址。
下手前先 `tccli dnspod DescribeRecordList` / `dig` 看清楚这个后缀下还有什么。
（我这个场景里所有子域名都指向同一台自建机，整体直连才是对的。）

---

## 四、生效方式：脚本是持久的，运行时配置要另外打补丁

**script 只在 Verge 重新生成配置时才跑**。想立刻生效，还要直接改生成物再热重载：

```bash
D=~/Library/Application\ Support/io.github.clash-verge-rev.clash-verge-rev

# 在 clash-verge.yaml 的 dns: 下插 fake-ip-filter，rules: 下插两条规则（略）

curl -X PUT --unix-socket /tmp/verge/verge-mihomo.sock \
  "http://localhost/configs?force=true" -d "{\"path\":\"$D/clash-verge.yaml\"}"
# 204 = 成功；非 204 说明 YAML 有问题，mihomo 会拒绝加载并继续用旧配置
```

两边都做：script 保证订阅更新后不丢，补丁保证当下就生效。

---

## 🔴 五、验证：唯一可信的判据是问 mihomo 自己

`dig` 返回真实 IP 只是**必要条件**，不能证明流量走了直连。
权威判据是 mihomo 的 `/connections`，看 `chains` 和命中的规则：

```bash
# 一边发请求，一边抓活动连接（连接结束就从列表消失，要并发抓）
curl -s --unix-socket /tmp/verge/verge-mihomo.sock http://localhost/connections \
 | python3 -c "
import sys,json
for c in json.load(sys.stdin).get('connections',[]):
    m=c.get('metadata',{}); h=m.get('host') or ''
    if 'yourdomain.cn' in h:
        print(h, '-> 链路', c.get('chains'), '规则', c.get('rule'), c.get('rulePayload',''))
"
```

看到 `链路 ['DIRECT'] 规则 DomainSuffix yourdomain.cn` 才算成。
走代理会是 `['🚀 代理', '🇺🇸 某节点']`。

**别拿耗时当判据**：我这次直连 1.06s、强制绑 en0 真直连反而 1.60s，
噪声比信号大，说明不了任何问题。

---

## 🔴 六、TUN 开着时，常规探测全是假信号

排查「连不上」时，下面这些手段在 TUN 模式下**会骗你**：

| 手段 | 假信号 |
|---|---|
| `nc -z host port` | **永远报 OPEN**（TUN 会伪造 TCP 握手） |
| `dig` / `nslookup` | 返回 `198.18.x.x` fake-ip，不是真实地址 |
| `curl --interface en0` | 只绑源地址，路由照样进 `utun1024`，无效 |
| 端口探测"连上了但没 banner" | 对 80/443 这类不发 banner 的服务毫无意义 |

**先看流量到底走哪**：

```bash
route -n get <IP> | grep -E 'interface|gateway'   # interface: utun1024 = 被 TUN 接管
```

**真直连探测**：macOS 上必须用 `IP_BOUND_IF` 套接字选项，并且要读到真实 banner 才算数。

🔴 **`IP_BOUND_IF = 25` 是 setsockopt 的选项常量，不是网卡序号。**
网卡序号必须 `socket.if_nametoindex('en0')` 现查（我这台是 12，且会变）。
我今天把 25 当成网卡序号传进去，得到 `[Errno 6] Device not configured`，
绑定静默失败、后续探测全走了代理，差点据此下错结论。

```python
import socket, struct
s = socket.socket()
s.setsockopt(socket.IPPROTO_IP, 25, struct.pack('I', socket.if_nametoindex('en0')))
s.settimeout(6); s.connect((ip, 22)); print(s.recv(100))   # 读到 SSH banner 才算真连上
```

同样的思路可以给 ssh 用，绕开 TUN 建隧道：

```
Host myserver
    ProxyCommand /usr/bin/python3 /Users/<you>/.ssh/bindconnect.py %h %p
```

`bindconnect.py` 就是上面那段 + 一个 `select` 循环在 stdin/stdout 和 socket 之间转发。

---

## 附：这套配置的文件位置（macOS / Clash Verge Rev）

```
~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/
├── profiles.yaml          # current: <uid> + 每个订阅的增强链绑定
├── profiles/
│   ├── <uid>.yaml         # 订阅原文
│   ├── <uid>.js           # script（改这个，认准 current 那条链）
│   └── Merge.yaml         # prepend-rules 在此版本无效
└── clash-verge.yaml       # 最终生成物，mihomo 实际加载的就是它
/tmp/verge/verge-mihomo.sock   # 控制接口（/configs /connections /proxies …）
```
