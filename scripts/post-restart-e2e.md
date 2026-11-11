# 重启后真机 e2e（本机自控，不需要第二台机器）

重启 DSH 桌面 App 后，插件的新代码才会加载。按顺序做，每步都应成功：

1. 监听器活着（新代码 = 同一个 /healthz，另外 host 现在是新代码）：
   ```bash
   curl -s http://127.0.0.1:5977/healthz
   ```
2. 面板可见：**设置 → 局域网桥接**，能看到本机、会话、被控端、控制端四块。
3. 本机自配对（拿到一次性 token，仅此一次可见）：
   对 agent 说：「用 lan_dsh_peers action=pair name=self capabilities=["read","prompt","control","create","archive"]」
4. 注册自己为出站 peer：
   「用 lan_dsh_peers action=add name=self url=http://127.0.0.1:5977 token=<上一步的 lzb_…>」
   期望 `reachable: true`。
5. 共享一个测试会话（面板勾选，或 `lan_dsh_share action=share sessionId=…`）。
6. 建会话：`session.create`（工具暂无独立入口，用 `lan_dsh_peers` 所在宿主 RPC；或让对端建）
   → 返回 `sessionId`，且自动进入共享列表。
7. 读/写：`lan_dsh_sessions peer=self` → `lan_dsh_prompt peer=self sessionId=… text="回一句 PONG"`
   → 期望 `reason: idle` 且回复里有 `PONG`。
8. 归档：`lan_dsh_archive action=archive peer=self sessionId=…` → `archived: true`
   → `lan_dsh_archive action=unarchive peer=self sessionId=…` → `archived: false`。
9. 权限门禁：用只带 `read` 的 token 调 `session.archive` → 期望 `bridge/forbidden`。
10. 收尾：`lan_dsh_peers action=remove name=self`；面板撤销 `self`；关掉共享开关。

失败时先看 `~/.dsh/lan-bridge/audit.jsonl`（每行一条 `{t,peer,method,sessionId,ok,ms}`），
它比任何猜测都准。
