# dsh-lan-bridge

让**同一个局域网里的另一台 DSH**（它的 agent，不是你的人手）读取、发指令、取消**本机**的 DSH 会话；
反过来本机也能驱动对端。一句话：agent 跨机器接管另一个 agent 的会话，而不是人肉开两个窗口。

这是 DSH 的 bundle 插件，Host 侧和 Web UI 面板都在一个包里，零第三方依赖（只用 `node:http` /
`node:crypto` / 全局 `fetch`），装完即用，不需要构建。

> **English**: a [DSH](https://github.com/deepseek-ai) bundle plugin that lets a DSH agent on the
> same LAN read, prompt and cancel the sessions of another DSH on this machine — and the other way
> round. Nothing is reachable by default: sessions are exposed one at a time through an explicit
> share switch, every peer holds its own bearer token with capability bits (`read` / `prompt` /
> `control` / `create` / `archive`), and the listener refuses browser origins, so a peer must be a
> DSH-speaking client, not a browser. Protocol contract: [PROTOCOL.md](PROTOCOL.md).

---

## 它做什么 / 不做什么

| 做 | 不做 |
| --- | --- |
| 把本机**被你显式勾选共享**的会话暴露给配对过的 peer | 不暴露整个 DSH、不暴露 Web GUI、不暴露文件系统 API |
| peer 可以：列会话、读历史、发 prompt、等回合结束、取消 | peer **不能**：共享/取消共享、创建会话（除非你显式打开）、代答审批 |
| 本机 agent 拿到 8 个 `lan_dsh_*` 工具去驱动 peer | 不做公网穿透、不做多用户 ACL、不做跨机 subagent 谱系 |
| 每条请求落审计日志（含 peer、方法、会话、成败） | 不记录 prompt 正文（只记元数据） |

两个方向、三个角色：`role: listener`（只被控制）/ `controller`（只控制别人）/ `both`（默认）。

## 安装

```bash
# 1) 确保 bundle 目录内容完整（index.js / client.js / lib / locale / cordis.patch.yml）
# 2) 在 DSH 里用插件管理器安装这个目录（绝对路径）
#    plugin_manager action=install_bundle target=/绝对路径/dsh-lan-bridge
# 3) 重启 DSH（桌面版退出重开），插件按 cordis.patch.yml 的默认配置挂载：
#    监听 127.0.0.1:5977（仅本机，LAN 不可达）+ 8 个工具 + 面板
```

装完在 Web UI 里应该能看到「局域网桥」面板（会话共享开关 / peer 列表 / 配对）。

## 配置

改 `cordis.patch.yml` 的 `config:` 后重装，或直接改 profile 里对应 patch 行：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `role` | `both` | `listener` / `controller` / `both` |
| `name` | 主机名 | peer 看到的本机名 |
| `listen.host` | `127.0.0.1` | 必须是 IP 字面量（`127.0.0.1` / `0.0.0.0` / `192.168.1.8`）或 `localhost`；`0.0.0.0` = 所有网卡。**面板里也能改，改完立即生效，不用重启** |
| `listen.port` | `5977` | 桥自己的端口（和 DSH Web 端口无关）；`0` = 让系统分配，实际端口看面板 |
| `insecureHttp` | `false` | 非 loopback 且无 TLS 时，必须显式设 `true` 才允许起监听（防止手滑裸奔） |
| `tls` | `null` | `{ certFile, keyFile }`，自签即可，配了就只用 HTTPS |
| `allowPeersToCreateSessions` | `true`（本 bundle 的 patch 里开好） | peer 能否在你机器上新建会话；新建的会话自动共享。还需 token 带 `create` 能力 |
| `trustedHosts` | `[]` | 额外接受的 `Host` 值（如 `my-mac.local:5977`） |
| `maxPromptBytes` | 16384 | 单条 prompt 上限 |
| `maxWaitMs` | 600000 | `session.wait` 上限 |
| `maxMessages` | 200 | 单次读历史条数上限 |
| `rateLimitPerMinute` | 120 | 每 peer 每分钟请求上限 |

### 面板里可以直接改监听设置

**设置 → 局域网桥 → 监听设置** 可以改 `host` / `port` / `insecureHttp` / `trustedHosts` /
TLS 证书路径 / 「允许对端新建会话」开关，**保存即生效，不需要重启 DSH**：

- 改 `host` 或 `port` 会重建监听：正在进行的远端调用会失败（亚秒级），失败的改动会**自动回滚**到
  原来的地址和端口，不会把你锁在连不上的状态里；
- 其它字段（信任主机、创建会话开关）只改内存，不断连接；
- 保存的值写进 `~/.dsh/lan-bridge/bridge.json` 的 `settings`，**优先级高于** `cordis.patch.yml` 的
  `config:`，所以下次启动沿用它；如果文件里的值已经非法（比如换成明文暴露却没勾确认），启动时会被
  忽略并回落到 YAML 的配置，不会让监听起不来。

绑非 loopback 地址时，**没有 TLS 就必须显式勾选「允许明文 HTTP」**：这是故意的手续，避免把会话
在局域网里裸奔当成一次手滑。

面板在 **设置 → 局域网桥**（`settings.section`，section id `lan-bridge`）：本机身份、监听状态、
逐会话共享开关、已配对 peer（撤销）、生成一次性配对 token。

状态存在 `$DSH_HOME/lan-bridge/`（`bridge.json` 0600 + `audit.jsonl`），重装插件不会丢配对；
要彻底重置就删这个目录。

## 配对（一次，两分钟）

被控机 A（要被人控制的那台）：

1. 在 A 的面板里把监听地址改成 A 的局域网 IP（或 `0.0.0.0`），勾选「允许明文 HTTP」（或配 TLS）→ 保存。**立即生效，不用重启**。
2. 打开「局域网桥」面板 → **配对 peer** → 输入名字（如 `b-mac`）→ 得到一次性 token `lzb_…`（只显示这一次）。
3. 面板里**勾选要共享的会话**。没勾的一个字节都读不到。

控制机 B（要下命令的那台）：

4. 让 B 的 agent 调 `lan_dsh_peers`：
   ```
   action=add  name=a-mac  url=http://192.168.1.8:5977  token=lzb_…
   ```
   返回里看到 `reachable` 才是通了。
5. `lan_dsh_sessions` 看 A 共享了哪些会话 → `lan_dsh_prompt {peer:"a-mac", sessionId:"…", text:"跑一下测试并汇报"}`。

审计：A 的 `$DSH_HOME/lan-bridge/audit.jsonl` 每行一条 `{t, peer, method, sessionId, ok, ms}`。

两个方向别混：**面板的“配对 peer”发的是入站 token**（别人来控我）；**出站**（我去控别人）只能在
控制侧用 `lan_dsh_peers action=add` 加，把对方面板给的 URL+token 填进去。想给对方 `control`（取消/改名/
切模型）或 `create`/`archive` 权限时，面板不够用，用 `lan_dsh_peers action=pair name=b-mac capabilities=["read","prompt","control","create","archive"]`
在 A 上签发，再把 token 交给 B。

## 对端提示词

控制侧（对端）那个 agent 需要一段说明才知道怎么用这套工具：见 **[docs/peer-prompt.md](docs/peer-prompt.md)**
（首次配对、日常主提示词、错误码应对、最短版）。

## 工具（控制侧）

| 工具 | 作用 |
| --- | --- |
| `lan_dsh_peers` | `list` / `add` / `check` / `remove`：配置与探测 peer；`pair`：**本机**签发一次性 token（可指定 `capabilities`，面板只发 read+prompt） |
| `lan_dsh_archive` | `archive` / `unarchive` 会话（`peer` 省略则作用于本机）；归档不删历史，可撤销；运行中的会话要 `stopActivity` 才归档 |
| `lan_dsh_share` | `list` / `share` / `unshare`：**本机**会话共享开关（peer 永远不能调这个） |
| `lan_dsh_sessions` | 列 peer 共享出来的会话 |
| `lan_dsh_transcript` | 读 peer 某会话的历史尾部（含 `seq type` 预览） |
| `lan_dsh_prompt` | 往 peer 会话发任务，默认等回合结束并回收回复 |
| `lan_dsh_wait` | 继续等一个还在跑的回合 |
| `lan_dsh_cancel` | 打断 peer 当前回合 |

## 安全模型（请照着读一遍）

信任边界有三层，默认全关：

1. **网络**：默认只绑 `127.0.0.1`。绑局域网 IP 需要显式 `insecureHttp: true`；明文 HTTP 下 token 在
   Wi-Fi 上可被嗅探，**能用要配 TLS，或在只含你可信设备的网段用**。请勿映射到公网。
2. **身份**：每个 peer 一个 `lzb_…` bearer token，只存 SHA-256，可随时在面板吊销。请求还要过
   `X-DSH-Bridge: 1` 自定义头（浏览器要发它必须先过 preflight，而 OPTIONS 一律拒绝）+ `Host` 栅栏 +
   拒绝任何 `Origin`/`Sec-Fetch-Site`/`Sec-Fetch-Dest`，挡掉浏览器侧 CSRF 与 DNS rebinding。
3. **会话**：peer 只看得到你勾了共享的会话；审批永远不代答。

**token 泄露 ≈ 把共享会话的执行权交出去**：共享会话里 agent 能跑 shell、改文件。所以：
只共享你真的愿意让对端驱动的会话；用完 `unshare`；发现异常立刻面板吊销。

审批（approval）与提问（ask_user_question）**不在 v1 支持范围内**：远端回合卡在审批时，
`lan_dsh_prompt`/`lan_dsh_wait` 返回 `reason: "input-required"`，需要 A 机上的人点一下。
这是有意的：让远端代替你点“允许”比不实现更危险。

## 已知限制

- **明文传输是默认形态**（TLS 需自签证书）；没有 token 轮换周期，只能吊销重建。
- **版本耦合**：映射的是 DSH 的 `sessionController`（尚属内部 API）。对端版本不同时，
  会返回 `bridge/method-unavailable` 而不是静默降级；跨版本用前先各自 `lan_dsh_peers check`。
- **无跨机 subagent 谱系**：远端会话在它自己的机器上，不会出现在本机会话树里。
- **不跨 Host 进程**：桥必须装在**持有那些会话的那个 Host 进程**里（桌面版就是桌面 App 自己）。
  另起一个 `dsh web --host <LAN IP>` 是另一个进程，碰不到桌面版的活会话（会话写锁会拒）。
- 一个 profile 一个桥；多 profile 要各自装、各自配对。
- `/events` SSE 有协议和实现，但本插件的工具都走一元 RPC（不需要长连接）；SSE 留给外部消费者与探针。

## 排障

| 现象 | 原因 / 下一步 |
| --- | --- |
| 面板不出现 | 插件没装上或被禁用：`plugin_manager action=list_plugins` 看 `dsh-lan-bridge` 是否 enabled；重启 DSH |
| 保存监听设置被拒（`bridge/forbidden`） | 选了非 loopback 地址但没勾「允许明文 HTTP」也没配 TLS —— 这是保护，不是 bug |
| `bridge/unreachable` | 端口没起 / 防火墙拦 / IP 变了：A 机上 `curl http://<ip>:5977/healthz` |
| `bridge/unauthorized` | token 不匹配或被吊销：面板重新配对 |
| `session/not-shared` | A 机上没勾共享，或刚 unshare：面板勾上 |
| `bridge/forbidden ... Host` | 访问用的主机名不在白名单：把 `host:port` 加进 `trustedHosts` |
| `input-required` | A 机有人在等你点审批，去那台机器处理 |

## 兼容性

- 在 **macOS 桌面版 DSH** 上开发和验证（协议 `protocol: 1`）。Linux / Windows 的 DSH 应该同样可用，
  但没实测；插件只依赖 `node:http`/`node:crypto`/`fetch`，没有平台相关代码。
- 依赖 DSH 的 `ctx.sessionController` / `ctx.workspaceController`（pre-stable 内部 API）。DSH 升级后
  若方法签名变动，桥会明确报 `bridge/method-unavailable`，而不是静默错乱——升级 DSH 后请跑一遍
  `node scripts/it-local.mjs`（离线，119 项）。
- 两端 `protocol` 必须一致：`bridge.hello` 会拒绝不匹配的版本。

## 贡献 / 反馈

- 协议是契约，形状改动要同步改 [PROTOCOL.md](PROTOCOL.md) 并说明原因；实现细节欢迎 PR。
- 改动后至少跑：`node scripts/it-local.mjs`（离线，无需 DSH）与 `node scripts/e2e-live.mjs`
  （需 DSH 在跑，会临时写入并清空 `bridge.json` 的 token，但保留你保存的监听设置）。
- 安全相关改动请顺带更新 README 的「安全模型」一节。

## 验证

离线自测（不需要第二台机器，也不需要连 Host；用假 Session 跑真实监听/方法表/工具）：

```bash
node scripts/it-local.mjs     # 68 项断言，退出码 0 = 全绿

真机自检（App 正在运行，会临时写入并在结束时清空 `bridge.json`）：

```bash
node scripts/e2e-live.mjs        # 22 项：栅栏/鉴权/hello/建会话/收发/归档/只读拒绝/SSE
```
```

对着一台真在跑的桥做协议探测：

```bash
export LAN_BRIDGE_URL=http://127.0.0.1:5977 LAN_BRIDGE_TOKEN=lzb_…
node scripts/probe.mjs health
node scripts/probe.mjs hello
node scripts/probe.mjs fence        # 安全栅栏负向测试
node scripts/probe.mjs e2e          # 本机自控一次完整回合
```

`scripts/e2e.md` 是人工验收清单（含第二台机器的验证步骤）。

## License

[MIT](LICENSE) © 2026 zq0929
