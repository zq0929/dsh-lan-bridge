# dsh-lan-bridge

[![ci](https://github.com/zq0929/dsh-lan-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/zq0929/dsh-lan-bridge/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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
#    监听 127.0.0.1:5977（仅本机，LAN 不可达）+ 12 个工具 + 面板 + 可选 mDNS
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

### 面板里签发令牌时可以勾选全部八个能力位

**设置 → 局域网桥 → 对等端 → 配对新对等端** 下面有一排能力开关：`read` / `prompt` /
`control` / `create` / `archive` / `collab` / `approve` / `files`，默认只勾 `read` + `prompt`。

- 想让它能新建会话、归档、或者读写共享板，就在面板里勾上对应位——不必再退回
  `lan_dsh_peers action=pair` 命令；
- `control`（取消/改名/换模型）、`create`（新建会话）、`archive`（归档/恢复）、`collab`
  （共享任务板与目标文档）、`approve`（代答审批）、`files`（在你声明的根目录里读写文件）
  都会让对等端**改变本机状态**，勾之前想清楚它是不是你信任的那台；
- 令牌仍然只显示一次、只存散列；勾错的代价是「撤销后重新签一枚」，所以宁可少勾；
- 列表为空会被拒绝（一个什么都不能做的 token 没有意义），未知名字会被忽略。

### 面板里可以直接改监听设置

**设置 → 局域网桥 → 监听设置** 可以改「本机名称」`name` / `host` / `port` / `insecureHttp` /
`trustedHosts` / TLS 证书路径 / 「允许对端新建会话」开关，**保存即生效，不需要重启 DSH**：

- **本机名称**就是 `bridge.hello` 和对端 `lan_dsh_peers list` 里显示的名字（默认取主机名）。
  改名不需要重建监听、不断开已配对的 peer，对端下次握手就看到新名字——两台机器默认都叫同一个
  主机名时，用这里区分；
- 改 `host` 或 `port` 会重建监听：正在进行的远端调用会失败（亚秒级），失败的改动会**自动回滚**到
  原来的地址和端口，不会把你锁在连不上的状态里；
- 其它字段（本机名称、信任主机、创建会话开关）只改内存，不断连接；
- 保存的值写进 `~/.dsh/lan-bridge/bridge.json` 的 `settings`，**优先级高于** `cordis.patch.yml` 的
  `config:`，所以下次启动沿用它；如果文件里的值已经非法（比如换成明文暴露却没勾确认），启动时会被
  忽略并回落到 YAML 的配置，不会让监听起不来。

绑非 loopback 地址时，**没有 TLS 就必须显式勾选「允许明文 HTTP」**：这是故意的手续，避免把会话
在局域网里裸奔当成一次手滑。

面板在 **设置 → 局域网桥接**（`settings.section`，section id `lan-bridge`）：本机身份、监听状态、
按工作区分层的会话共享、已配对 peer（撤销）、生成一次性配对 token。

状态存在 `$DSH_HOME/lan-bridge/`（`bridge.json` 0600 + `audit.jsonl`），重装插件不会丢配对；
要彻底重置就删这个目录。

### 会话按工作区分层，也能整组共享

会话多的时候不再是一长条平铺列表。面板把会话按**工作区**分组：

- 优先用 DSH 自己的工作区注册表（`ctx.workspaceRegistry`）：真实的工作区名、路径和成员都来自它；
  没有注册表的 Host 也能用会话的 `cwd` 合成组（组标题取路径末段），所以两边看起来一样。
- 分组依据是 **cwd 精确相等**（和 DSH 自己 `WorkspaceEntity.sessionIds` 一致），不是路径前缀；
  没有 cwd 的会话归到「其他会话」，永远排在最后；空工作区也会列出来，可以先勾上再建会话。
- 每个组默认收起，点标题展开后逐个会话勾选共享；组头还有一个 **「共享整个工作区」** 开关。
- 打开组规则后，这个工作区**当前所有会话**会立刻共享，之后在其中新建的会话也会自动共享
  （Host 监听 `api-session/added`）。关掉规则只撤销它自己生成的共享；**你手工勾过的会话不会被
  关掉，手工决定永远优先**。规则与自动生成的共享记录在 `bridge.json` 的
  `workspaceShares` / `autoShares` 里，逐会话开关仍写回原来的 `shares`，所以对端 `session.list`
  / `lan_dsh_sessions` / SSE 看到的还是同一套「已共享」判定，无需升级对端。
- 老版本面板（没有 `workspaces` 字段）会自动回落到原来的扁平 `sessions` 列表，不会白屏。

用工具侧看也一样：`lan_dsh_share action=list` 显示的是 effective 值（自己的勾选或组规则都算）。
整组共享目前只在面板里操作；逐会话操作仍可用 `lan_dsh_share`。

## 配对（一次，两分钟）

被控机 A（要被人控制的那台）：

1. 在 A 的面板里把监听地址改成 A 的局域网 IP（或 `0.0.0.0`），勾选「允许明文 HTTP」（或配 TLS）→ 保存。**立即生效，不用重启**。
2. 打开「局域网桥」面板 → **配对 peer** → 输入名字（如 `b-mac`）→ 得到一次性 token `lzb_…`（只显示这一次）。
3. 面板里**展开工作区、勾选要共享的会话**（或打开该组的「共享整个工作区」）。没勾的一个字节都读不到。

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
切模型）或 `create`/`archive`/`collab`/`approve`/`files` 权限时，面板不够用，用 `lan_dsh_peers action=pair name=b-mac capabilities=["read","prompt","control","create","archive","collab"]（要代答审批再加 `"approve"`）`
在 A 上签发，再把 token 交给 B。

## 对端提示词

控制侧（对端）那个 agent 需要一段说明才知道怎么用这套工具：见 **[docs/peer-prompt.md](docs/peer-prompt.md)**
（首次配对、日常主提示词、错误码应对、最短版）。

## 工具（控制侧）

| 工具 | 作用 |
| --- | --- |
| `lan_dsh_peers` | `list` / `add` / `check` / `remove`：配置与探测 peer；`pair`：**本机**签发一次性 token（可指定 `capabilities`；面板里也是各能力位随便勾）；`grant`：给**已配对**的对端原位改权限，不换 token |
| `lan_dsh_archive` | `archive` / `unarchive` 会话（`peer` 省略则作用于本机）；归档不删历史，可撤销；运行中的会话要 `stopActivity` 才归档 |
| `lan_dsh_share` | `list` / `share` / `unshare`：**本机**会话共享开关（peer 永远不能调这个） |
| `lan_dsh_sessions` | 列 peer 共享出来的会话 |
| `lan_dsh_transcript` | 读 peer 某会话的历史尾部（含 `seq type` 预览） |
| `lan_dsh_prompt` | 往 peer 会话发任务，默认等回合结束并回收回复（自动从回复里的 cursor 起算，不会把旧回合混进来）；可带 `intent` 说明意图 |
| `lan_dsh_approval` | `list` / `answer`：列出并代答 peer 卡住的审批（需要该 token 带 `approve` 能力，默认不签） |
| `lan_dsh_board` | 读共享板：两台机器的任务 + 目标文档（`machine/id` 命名空间，只读合并） |
| `lan_dsh_task` | 在共享板上建任务 / 按 revision CAS 改任务（认领、完成、改依赖、改派）/ `action=transfer` 把任务归属交给另一台机器 |
| `lan_dsh_goal` | 读 / CAS 写 / 清空 / **双向收敛**共享目标文档（"什么叫做完"写在这里） |
| `lan_dsh_wait` | 继续等一个还在跑的回合；可带 `afterSeq` 只读某个序号之后的新内容 |
| `lan_dsh_cancel` | 打断 peer 当前回合 |
| `lan_dsh_push_file` | 把一个本地文件推到 peer 的某个共享根下（分块 + sha256 校验；需要该 token 带 `files`，且目标根可写） |
| `lan_dsh_pull_file` | 从 peer 的共享根拉一个文件到本机（先写临时文件，校验通过才改名） |
| `lan_dsh_files` | 只读探查对端：`roots`（共享了哪些根、是否可写）/ `list` / `stat` |

## 安全模型（请照着读一遍）

信任边界有三层，默认全关：

1. **网络**：默认只绑 `127.0.0.1`。绑局域网 IP 需要显式 `insecureHttp: true`；明文 HTTP 下 token 在
   Wi-Fi 上可被嗅探，**能用要配 TLS，或在只含你可信设备的网段用**。请勿映射到公网。
2. **身份**：每个 peer 一个 `lzb_…` bearer token，只存 SHA-256，可随时在面板吊销。请求还要过
   `X-DSH-Bridge: 1` 自定义头（浏览器要发它必须先过 preflight，而 OPTIONS 一律拒绝）+ `Host` 栅栏 +
   拒绝任何 `Origin`/`Sec-Fetch-Site`/`Sec-Fetch-Dest`，挡掉浏览器侧 CSRF 与 DNS rebinding。
3. **会话**：peer 只看得到你勾了共享的会话；审批默认不代答（要代答必须显式签发 `approve` 能力，见下）。
4. **文件**：默认完全关闭；开启后也只能碰你在面板里逐个声明的根目录，审批/文件各是一个独立能力位，
   都要单独签发。绝对路径永不过线。

**token 泄露 ≈ 把共享会话的执行权交出去**：共享会话里 agent 能跑 shell、改文件。所以：
只共享你真的愿意让对端驱动的会话；用完 `unshare`；发现异常立刻面板吊销。

### 文件传输（0.4.0 起，默认关闭）

会话里说"把那个日志传给我"时，桥可以直接搬字节，不用你手敲 scp。两端各做两件事：

**被控侧**（面板 → 局域网桥接 → 文件传输）：

1. 打开「允许对端传输文件」；
2. 加一个根目录，例如名称 `workspace`、路径 `D:\Users\me\Documents\dsh`，需要写入就打开「可写」；
3. 保存；然后给对端的 token 勾上 `files`（或 `lan_dsh_peers action=grant name=b-mac capabilities=["read","prompt","files"]`）。

**控制侧**：

```bash
lan_dsh_files  { peer: "b-mac", action: "roots" }                       # 先看它共享了哪些根
lan_dsh_push_file { peer: "b-mac", localPath: "./report.pdf",
                    root: "workspace", remotePath: "inbox/report.pdf" }
lan_dsh_pull_file { peer: "b-mac", root: "workspace",
                    remotePath: "out/app.log", localPath: "./app.log" }
```

规则：

- 线上只传 `{ root, path }`，`path` 是 POSIX 风格相对路径；**绝对路径、盘符、`..`、Windows 设备名一律拒绝**
  （这类是 `bridge/bad-request`：请求本身不对，不是权限问题；只有真缺 `files` 能力时错误里才会带
  “去 grant” 的提示），
  解析后再用 `realpath` 复核，符号链接逃逸也是 `bridge/forbidden`。
- 分块 base64（默认 256 KiB/块），`files.begin` 就先拒掉未知根、越界路径、超限大小、已存在的目标，
  不会先把带宽浪费掉再报错。
- 先落 `<DSH_HOME>/lan-bridge/staging/`，`sha256` 校验通过才 `rename` 到目标；`abort`、崩溃、过期都不会留下半截文件。
- 每次提交与读完都写审计（`direction`/`root`/`path`/`bytes`/`sha256`）。
- 同一 peer 同时只允许一个上传（`bridge/rate-limited`）；单文件上限默认 256 MiB，可在面板改。

### 跨机代答审批（0.3.13 起，默认关闭）

远端回合卡在审批时，`lan_dsh_prompt`/`lan_dsh_wait` 返回 `reason: "input-required"`。默认仍然要 A 机上的人点一下；
如果那台机器上没有人在，可以显式授权对端代答：

```bash
lan_dsh_peers action=pair name=b-mac capabilities=["read","prompt","approve"]
```

然后在 A 机的 agent 里：

```bash
lan_dsh_approval { action: "list", peer: "b-mac" }
lan_dsh_approval { action: "answer", peer: "b-mac", id: "8b1d…", decision: "allow" }
```

规则（写死，不能改配置绕过）：

- `approve` **不在默认能力里**，配对只会给 `read`+`prompt`；签发它等于把"允许本机跑一次被拦下的工具调用"的权力交出去。
- **已经发出去的 token 不会自动获得 `approve`**（也不会自动失去）。要提权用
  `lan_dsh_peers action=grant name=b-mac capabilities=["read","prompt","approve"]` —— 原位改、token 不变，
  不必让对方重配；`capabilities` 是**替换**不是追加，要给全集。
- 两台机器各自独立：A 能代答 B 的审批，只取决于 **B 上签给 A 的 token** 有没有 `approve`，与 A 签给 B 的无关，所以谁先配都行。
- 只对**已共享会话**生效；未共享会话的审批既列不出来也答不了。
- 代答是**有界等待**：120 秒（`approvalRelayMs`）内没收到远端答复就自动落回本机的人工弹窗，所以不会把回合卡死。
- 每次代答在 `audit.jsonl` 里留一行（`method: "approval.answer"`），含 peer、会话、工具、决定。
- Host 自己的 `never` 审批策略在本插件之前生效，**代答无法绕过**它。
- 提问（`ask_user_question`）**仍不支持**代答：那需要理解上下文才能答，不属于机械决定。

### 共享板：把"做到哪一步"也送过去

意图信封解决的是一句话里的"为什么"。跨机的**多回合协作**还需要一个双方都能读写的状态：谁在做什么、什么卡住什么、什么叫做完。这就是共享板（`lan_dsh_board` / `lan_dsh_task` / `lan_dsh_goal`）。

**任务归属可以跨机转移。** 任务只在拥有它的那台机器上可写，这是防冲突的设计；但真协作时经常需要"这条活儿换个人干"。所以有 `lan_dsh_task action=transfer`：

```
lan_dsh_task action=transfer taskId=t-mwbszbdv-jkn1 to=windows          # 把我这条交给 windows
lan_dsh_task action=transfer peer=windows taskId=t-abc to=lead-mac      # 让 windows 把它那条交给我
```

板子会脏，脏了就得能清。`taskAction=delete` 是真删，但留一块墓碑（id / 主题 / 谁删的 / 何时），所以事后还能回答"这条是删了还是从没建过"。有别的任务被它阻塞时删除会被拒（`board/conflict`，附 `dependents`）；真要删就重复一次带 `force=true`，那时**依赖它的任务会自动去掉这个阻塞项**（revision +1，并在 `relinked` 里列出），所以不会有任务永远等一个鬼。墓碑会出现在 `lan_dsh_board` 的读结果里（最近 10 条），已完成的任务也可以删：这不是抹掉历史，这是让板子保持可读。目标文档同理：`lan_dsh_goal action=clear` 清空但**仍然递增 revision**，下一个写的人必须带上真正读到的版本号，所以"清空"不会被当成"重置到 0"。

转移是**搬**不是**标**：先让接收方 `tasks.adopt` 收下，成功之后才删本地那条。接收方不可达、revision 过期、或任务已完成，都会在本地原样保留 —— 不会出现"两边都没有"的空档。接收方拿到后是新的 owner，可以继续 `claim` / `complete`；记录里留 `origin.machine` 说明它从哪儿来。

**目标文档会自己对齐。** 两台机器各存一份 goal，靠 revision 排序：读板的时候顺手收敛——对方版本更高就拉下来，我方更高就推过去，输出里会写一行 `goal converged with windows (rev 3) → now rev 4 [pulled]`。所以要手动 `lan_dsh_goal action=sync` 才对齐的时代过去了：只要有人看一眼板子，落后的那份就被纠正。唯一不自动处理的是**同版本不同文本**（两台机器离线各写了一次）：那时报 `goal DIVERGED with …`，让人来写第三次，而不是让桥去猜谁对。没有向量时钟是故意的——宁可暴露一次分叉，也不假装合并。

它按"谁创建谁拥有"复制，而不是搞一个中心库：

```
本机 board（bridge.json）        对端 board（对端 bridge.json）
  tasks: t-abc …                 tasks: t-xyz …
  goal:  revision 3              goal:  revision 3
        ↑                              ↑
        └── 读的时候各自 pull 对方 ─────┘   （对端离线也能工作）
```

- **任务只在创建它的机器上可改**：跨机冲突从结构上消失，不需要合并算法；合并读出来的 id 带机器前缀（`my-mac/t-abc`），两台机器不会撞 id。
- **改任务必须带 revision**（CAS）：读到 rev 2 才能写 rev 2，过期写入返回 `board/conflict` 并附上当前任务，让你重读再试，绝不盲改。
- **目标文档是双方都写的那一份**：同样用 revision 保护，谁后写谁的 `updatedBy` 记谁；`revision` 递增，读到旧值就重读。
- **依赖是建议性的**：`blockedBy` 里有未完成的任务，`ready` 就是 false；对方不可达时任务仍然可读，只是标 `unreachable`。
- 全部方法都要 `collab` 能力位（面板签的 token 默认**没有**它），所以对端即使拿到默认 token 也读不到你的板。

两个典型用法：

```jsonc
// A 机把活拆开，写给两边看
{ "action": "create", "subject": "把 0.3.0 发出去",
  "blockedBy": [], "assignee": "my-mac" }
// B 机读到后认领自己那半（B 只能改 B 自己建的任务，所以 A 建的任务由 A 认领，
// 或者 A 用 taskAction=reassign 指定 assignee）
{ "action": "update", "taskId": "t-abc", "expectedRevision": 2, "taskAction": "claim" }
// 双方对"做完"达成一致
{ "action": "set", "expectedRevision": 0, "title": "0.3.0",
  "text": "done = 两台机器都能读回同一条 goal，且 board 测试全绿" }
```

### 意图信封：把"为什么发这条"也送过去

只发文本时，对端只能从一个接一个的句子里猜你的计划。给 `lan_dsh_prompt` 加 `intent`，桥会在文本之前渲染一个定界块，对端的 agent 就能按计划而不是按修辞回应：

```jsonc
{ "peer": "a-mac", "sessionId": "session-…", "text": "先跑单元测试，失败就停下来汇报",
  "intent": {
    "goal": "确认 main 分支还能过 CI",
    "plan": ["跑 pnpm test", "失败则只报前三条原因", "通过则跑一次真机 e2e"],
    "expects": "通过/失败 + 失败原因，不要建议改法",
    "deadline": "这一回合内",
    "format": "三行以内"
  } }
```

对端收到的是 `[lan-bridge intent] … [/lan-bridge intent]` 块加正文。信封是**建议性的**：对端忽略它也能看到一条普通提示词；格式不合法（缺 `goal`、`plan` 不是数组、字段超长）会被 `bridge/bad-request` 拒掉。收到的信封会按会话保存在接收方（最新 20 条），可用 RPC `session.intents` 读回，方便复盘"当时为什么要发这句"。
这是有意的：让远端代替你点“允许”比不实现更危险。

### 局域网发现：不用再问"你的 IP 是多少"

打开开关**立即生效**（不用重启）：`syncDiscovery` 会在保存时起停 responder。但要注意 mDNS 是
**链路本地**的（`224.0.0.251` 不过路由）——两台机器必须在同一网段/同一桥接段。能互 ping 端口却
隔着路由（例如 `172.17.45.x` 与 `172.17.46.x` 各是一个 /24）时，发现一定失败，这时用手工
`lan_dsh_peers action=add` 填地址即可，与拓扑无关。

面板里打开 **局域网发现（mDNS）**（或 `config.discovery.enabled: true`），本机就会在局域网里广播自己：名字、监听端口、版本，以及一条 A 记录。对端一句 `lan_dsh_peers action=discover` 就能看到候选：

```
discovered over mDNS:
  windows  http://172.17.45.8:5977  v0.3.5
  my-pc    http://192.168.1.9:5977  v0.3.5  (already added)
```

**广播里没有令牌，也授不了权。** mDNS 只回答"它在哪"，"谁能驱动它"仍然由对端面板签发的 bearer token 决定，会话仍要靠 `share` 逐个点开。这是刻意的分层：网络可以知道你的地址，但只有你能决定谁可以动手。发现只是省了问 IP 这一步，配对还是要人工做一次。

端口广播的是**实际绑定端口**（配置写 `port: 0` 时也不会广播 0）；多网卡只广播第一个非回环 IPv4。

## 已知限制

- **明文传输是默认形态**（TLS 需自签证书）；没有 token 轮换周期，只能吊销重建。
- **文件传输不是通用网盘**：不做目录递归、断点续传、多文件批量（调用方循环）、也不做流式；
  它只在你声明的根里搬单个文件，`files` 能力位等于"在该根内任意读写"，按高权能力对待。
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
  `node scripts/it-local.mjs`（离线，266 项）。
- 两端 `protocol` 必须一致：`bridge.hello` 会拒绝不匹配的版本。

## 贡献 / 反馈

- 协议是契约，形状改动要同步改 [PROTOCOL.md](PROTOCOL.md) 并说明原因；实现细节欢迎 PR。
- 改动后至少跑：`node scripts/it-local.mjs`（离线，无需 DSH）、`node scripts/panel-smoke.mjs`
  （渲染真实 `client.js`，不需要 React/浏览器）与 `node scripts/e2e-live.mjs`（需 DSH 在跑，
  会临时写入 token 并在结束时把 `bridge.json` 原样恢复）。
- 安全相关改动请顺带更新 README 的「安全模型」一节。

## 验证

离线自测（不需要第二台机器，也不需要连 Host；用假 Session 跑真实监听/方法表/工具）：

```bash
node scripts/it-local.mjs     # 266 项断言，退出码 0 = 全绿
node scripts/panel-smoke.mjs  # 面板冒烟：用迷你 React 渲染真实 client.js，28 个场景
```

面板那一套是补出来的：0.3.5 有一个 bug 是"Host 比面板旧 → 面板整体白屏报『状态读取失败』"，
因为面板读了新 Host 才有的 `discovery` 字段。这类错误在 Host 侧测试里看不见，只能渲染面板才抓得住。

真机自检（App 正在运行，会临时写入并在结束时恢复 `bridge.json`）：

```bash
node scripts/e2e-live.mjs        # 24 项：栅栏/鉴权/hello/建会话/收发/归档/只读拒绝/SSE
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
