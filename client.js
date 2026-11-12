/**
 * Browser half of the LAN bridge panel: one Settings section
 * (`settings.section`) that renders the bridge as a page of cards. The page
 * refreshes itself every 3 s while it is on screen (and on window focus), and
 * nothing inside it trusts a payload: a Host older than the panel, a missing
 * key or a malformed list degrades to an empty or partial card, never to a
 * thrown render.
 *
 * Layout (top to bottom), each block one `.dslb-card` of the same column:
 *   1. `StatusHero`    — name, role pill, listener state line, copyable address
 *   2. `ListenSettings`— the listener itself: name, bind address/port, plaintext
 *                        consent, mDNS switch, trusted hosts, TLS pair, sticky
 *                        save bar. Saving POSTs the whole settings set and
 *                        replaces the panel state with the state the answer
 *                        carries, so a clamped port or a failed rebind shows up
 *                        in the same paint. No optimistic write, no re-read.
 *   3. `Peers`         — inbound / outbound sub-cards plus `Pairing` (a one-time
 *                        token, shown once, never persisted here)
 *   4. `Sessions`      — the panel's main decision surface: one collapsible row
 *                        per workspace (`WorkspaceGroup`, closed by default, a
 *                        switch that shares the whole workspace) over indented
 *                        per-session switches. Both levels are optimistic and
 *                        revert on refusal. A workspace rule makes the sessions
 *                        under it effectively shared, so their own switches
 *                        render checked and disabled instead of lying about it.
 *                        A Host that sends no `workspaces` key keeps the old
 *                        flat list.
 *   5. `Discovery`     — mDNS neighbours heard on the LAN (read-only)
 *
 * Every read goes through the Host's own cookie-authenticated route
 * (`api/lan-bridge.*` on the Web listener), never through the bridge
 * listener itself: browsers are not peers, so the bridge's own `/rpc`
 * fence refuses them by design.
 *
 * Style notes — the metrics are copied from the shell's own Settings page
 * (`dsh/client-ui-settings-*`), not invented: a 720px column of
 * `settings-card-fill` cards with a 0.5px `settings-card-stroke` edge and
 * `--dsw-radius-xl` corners, 12/14px card padding, 12px gaps, 32px inputs on
 * `bg-base` with a 0.5px `border-l2` edge and a 12px radius, labels above the
 * field, 14px row titles over 12px descriptions, mono 12px for addresses and
 * tokens. Every `var()` carries a literal fallback so a renamed token drops
 * the declaration rather than the surface. Two deliberate deviations: the
 * focus ring takes its width from `--dsw-focus-ring-width` but its colour from
 * `--dsw-alias-brand-primary`, because `--dsw-focus-ring-color` resolves to
 * `transparent` in the base theme; and `#fff` appears only as the fallback for
 * `--dsw-alias-label-primary-foreground`, never as a surface, and the one
 * literal `#fff` switch knob is a shape on a tinted track (the on-state knob
 * has to flip with the theme because the brand fill does). Dark mode holds
 * because every surface, border and label is a token.
 */

window.__ModuleLoader__.load({
  id: 'dsh-lan-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this panel's registrations bind to. */
    const NS = 'lanBridge'

    /** Section id: the Settings nav row, the icon match key, and this page. */
    const SECTION_ID = 'lan-bridge'

    const DICT = {
      zh: {
        nav: '局域网桥接',
        title: '局域网桥接',
        subtitle: '受信任的对等端可以读取并驱动你勾选的会话。',
        thisMachine: '本机',
        role: '角色',
        roleListener: '仅监听',
        roleController: '仅控制',
        roleBoth: '双向',
        roleUnknown: '未配置',
        peerName: '对等端名称',
        listen: '监听地址',
        sessions: '会话',
        sessionsHint: '只有已共享的会话会出现在对等端的 session.list 中。',
        running: '运行中',
        idle: '空闲',
        share: '共享给对等端',
        noSessions: '暂无可共享的会话',
        peers: '对等端',
        inbound: '入站',
        outbound: '出站',
        noInbound: '暂无入站对等端',
        noOutbound: '暂无出站对等端',
        never: '从未连接',
        justNow: '刚刚',
        minutesAgo: '{count} 分钟前',
        hoursAgo: '{count} 小时前',
        revoke: '撤销',
        revokeConfirm: '确认撤销',
        revokeHint: '撤销后该对等端的令牌立即失效',
        reachable: '可达',
        unreachable: '不可达',
        pair: '配对新对等端',
        pairPlaceholder: '对等端名称',
        pairSubmit: '生成令牌',
        pairCancel: '取消',
        pairNameRequired: '请填写对等端名称',
        pairFailed: '配对失败',
        pairCapabilities: '令牌权限',
        pairCapNone: '至少选择一个权限',
        pairCapHint: '控制、新建、归档、协作会授予对等端改变本机状态的能力；只读与发消息只能读和说话。',
        pairCapsLine: '权限：{caps}',
        tokenMissing: '服务端没有返回令牌',
        revokeFailed: '撤销失败',
        shareFailed: '共享状态切换失败',
        tokenTitle: '令牌（仅显示一次）',
        tokenFor: '已为 {name} 生成令牌',
        tokenOnce: '请立即复制并交给对等端：关闭后无法再次查看，服务端只保存散列。',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败，请手动选择',
        dismiss: '关闭',
        loading: '读取中…',
        loadFailed: '状态读取失败',
        retry: '重试',
        empty: '—',
        capRead: '读取',
        capControl: '控制',
        capArchive: '归档',
        capPrompt: '发消息',
        capCancel: '取消',
        capWait: '等待',
        capTranscript: '记录',
        capCreate: '创建会话',
        capCollab: '协作板',
        capApprove: '代答审批',
        capRename: '重命名',
        capSelectModel: '切换模型',
        cancel: '取消',
        settingsTitle: '监听设置',
        settingsHint: '改这里就等于改监听配置：保存后立即重建监听器，不需要改 cordis.patch.yml，也不需要重启 Host。',
        settingsName: '本机名称',
        settingsNameHint: '对端列表和 hello 握手里显示的名字。改名立即生效，不会重建监听器。',
        settingsNameMissing: '本机名称不能为空',
        settingsNameTooLong: '本机名称最多 64 个字符',
        settingsNameLive: '改名不需要中断连接，已配对的 peer 下次握手就能看到新名字。',
        settingsHost: '监听地址',
        settingsHostHint: '127.0.0.1 只接受本机连接；0.0.0.0 表示所有网卡。',
        settingsPort: '端口',
        settingsPortHint: '0 = 自动分配（由系统选一个空闲端口）',
        settingsPortAuto: '系统当前分配的端口：{port}',
        settingsAllowCreate: '允许对端新建会话',
        settingsAllowCreateHint: '对等端可以在本机新建会话，保存后立即生效。',
        settingsDiscovery: '局域网发现（mDNS）',
        settingsDiscoveryHint: '在本机广播名字、地址和端口，方便别人直接找到你；令牌不会广播，配对仍需手动。',
        settingsTrustedHosts: '信任主机',
        settingsTrustedHostsHint: '对端用主机名访问时，Host 头要命中白名单。多个用逗号或空格分隔。',
        settingsTrustedHostsPlaceholder: 'mac.local:5977 nas.lan:5977',
        settingsAddresses: '本机地址',
        settingsTlsCert: 'TLS 证书',
        settingsTlsKey: 'TLS 私钥',
        settingsTlsHint: '两个都填绝对路径，或都不填；只填一个会被拒绝。',
        settingsTlsHalf: '证书和私钥必须同时填写，或同时留空。',
        settingsInsecure: '允许明文 HTTP：token 会在局域网里明文传输',
        settingsInsecureWarning: '当前设置会被服务端拒绝：对外监听但没有 TLS。可以勾选「允许明文 HTTP」，或填写 TLS 证书与私钥。',
        settingsHostMissing: '请填写监听地址。',
        settingsPortInvalid: '端口必须是 0–65535 之间的整数。',
        settingsSave: '保存',
        settingsSaving: '保存中…',
        settingsSaved: '已保存，监听器已按新配置重建。',
        settingsSaveFailed: '保存失败',
        settingsSaveBlocked: '当前表单还不能保存',
        settingsListenWarning: '保存后监听会重建，正在进行的远端调用会断开约一秒；失败会自动回滚。',
        settingsRestartRequired: '部分改动需要重启 Host 才会完全生效。',
        settingsNotListening: '未监听',
        settingsListenError: '监听失败：{message}',
        settingsStateMissing: '服务端没有返回新的状态',
        listening: '监听中',
        plainHttp: '明文 HTTP',
        tlsShort: 'TLS',
        copyAddress: '复制地址',
        settingsDirty: '未保存',
        peersHint: '入站是对等端持有本机令牌；出站是本机持有对方令牌。',
        inboundHint: '持有本机令牌、可以连进来的对等端',
        outboundHint: '本机作为控制端连接的对等端',
        pairHint: '生成一枚只显示一次的令牌，交给另一台机器。',
        noSessionsNext: '在 DSH 里开一个会话后回到这里，就能决定是否把它共享给对等端。',
        noInboundNext: '点「配对新对等端」生成令牌，交给另一台机器。',
        noOutboundNext: '在另一台机器上把本机令牌配对过去，它就会出现在这里。',
        noDiscovery: '还没有听到局域网里的其它机器',
        noDiscoveryOff: '局域网发现已关闭',
        noDiscoveryNext: '在同一网段里打开上面监听设置中的「局域网发现（mDNS）」，其它同样打开的机器就会自动出现在这里。',
        discoveryFoundHint: '同一网段里广播自身的机器；令牌从不广播，配对仍需手动。',
        discoveryError: '发现失败：{message}',
        wsExpand: '展开工作区',
        wsCollapse: '收起工作区',
        wsSessions: '{count} 个会话',
        wsSharedCount: '{count} 已共享',
        wsWholeShared: '工作区已整体共享，新会话自动共享',
        wsShareHint: '共享整个工作区后，其中的会话不必逐个勾选。',
        wsEmpty: '暂无会话',
        wsEmptyNext: '共享此工作区后，新建会话将自动共享。',
        wsOther: '其他会话',
        wsShareAll: '共享整个工作区',
        wsShareFailed: '工作区共享切换失败',
        wsExpandAll: '全部展开',
        wsCollapseAll: '全部收起',
      },
      en: {
        nav: 'LAN bridge',
        title: 'LAN bridge',
        subtitle: 'Trusted peers can read and drive the Sessions you share here.',
        thisMachine: 'This machine',
        role: 'Role',
        roleListener: 'Listener',
        roleController: 'Controller',
        roleBoth: 'Both',
        roleUnknown: 'Not configured',
        peerName: 'Peer-visible name',
        listen: 'Listening on',
        sessions: 'Sessions',
        sessionsHint: 'Only shared Sessions appear in a peer\'s session.list.',
        running: 'Running',
        idle: 'Idle',
        share: 'Share with peers',
        noSessions: 'No Session to share yet',
        peers: 'Peers',
        inbound: 'Inbound',
        outbound: 'Outbound',
        noInbound: 'No inbound peer',
        noOutbound: 'No outbound peer',
        never: 'Never connected',
        justNow: 'just now',
        minutesAgo: '{count} min ago',
        hoursAgo: '{count} h ago',
        revoke: 'Revoke',
        revokeConfirm: 'Confirm revoke',
        revokeHint: 'The peer\'s token stops working immediately',
        reachable: 'Reachable',
        unreachable: 'Unreachable',
        pair: 'Pair a peer',
        pairPlaceholder: 'Peer name',
        pairSubmit: 'Create token',
        pairCancel: 'Cancel',
        pairNameRequired: 'Enter a peer name',
        pairFailed: 'Pairing failed',
        pairCapabilities: 'Token capabilities',
        pairCapNone: 'Select at least one capability',
        pairCapHint: 'Control, create, archive and collab let the peer change this machine; read and prompt only let it look and speak.',
        pairCapsLine: 'Capabilities: {caps}',
        tokenMissing: 'The Host returned no token',
        revokeFailed: 'Revoke failed',
        shareFailed: 'Could not change sharing',
        tokenTitle: 'Token (shown once)',
        tokenFor: 'Token created for {name}',
        tokenOnce: 'Copy it to the peer now: it cannot be shown again, the Host keeps only a hash.',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed, select it manually',
        dismiss: 'Dismiss',
        loading: 'Reading…',
        loadFailed: 'Could not read state',
        retry: 'Retry',
        empty: '—',
        capRead: 'read',
        capControl: 'control',
        capArchive: 'archive',
        capPrompt: 'prompt',
        capCancel: 'cancel',
        capWait: 'wait',
        capTranscript: 'transcript',
        capCreate: 'create',
        capCollab: 'collab',
        capApprove: 'approvals',
        capRename: 'rename',
        capSelectModel: 'select model',
        cancel: 'Cancel',
        settingsTitle: 'Listener',
        settingsHint: 'This is the listener itself: saving rebuilds it immediately, with no edit to cordis.patch.yml and no Host restart.',
        settingsName: 'Machine name',
        settingsNameHint: 'The name peers see in their lists and in the hello handshake. Renaming applies at once without rebuilding the listener.',
        settingsNameMissing: 'The machine name cannot be empty',
        settingsNameTooLong: 'The machine name is limited to 64 characters',
        settingsNameLive: 'Renaming does not drop connections: a paired peer sees the new name on its next handshake.',
        settingsHost: 'Bind address',
        settingsHostHint: '127.0.0.1 accepts this machine only; 0.0.0.0 means every interface.',
        settingsPort: 'Port',
        settingsPortHint: '0 = pick a free port automatically',
        settingsPortAuto: 'Port assigned right now: {port}',
        settingsAllowCreate: 'Let peers create Sessions',
        settingsAllowCreateHint: 'A peer can create a Session on this machine; takes effect on save.',
        settingsDiscovery: 'LAN discovery (mDNS)',
        settingsDiscoveryHint: 'Announce this machine’s name, address and port so peers can find it; tokens are never broadcast, so pairing stays manual.',
        settingsTrustedHosts: 'Trusted hosts',
        settingsTrustedHostsHint: 'When a peer connects by host name, its Host header must match an entry. Separate with commas or spaces.',
        settingsTrustedHostsPlaceholder: 'mac.local:5977 nas.lan:5977',
        settingsAddresses: 'This machine',
        settingsTlsCert: 'TLS certificate',
        settingsTlsKey: 'TLS private key',
        settingsTlsHint: 'Fill both with absolute paths, or neither; filling only one is refused.',
        settingsTlsHalf: 'Certificate and key must both be filled in, or both left empty.',
        settingsInsecure: 'Allow plaintext HTTP: tokens travel over the LAN in the clear',
        settingsInsecureWarning: 'The Host will refuse this: an outward bind without TLS. Tick "Allow plaintext HTTP", or fill in the TLS certificate and key.',
        settingsHostMissing: 'Enter a bind address.',
        settingsPortInvalid: 'The port must be an integer between 0 and 65535.',
        settingsSave: 'Save',
        settingsSaving: 'Saving…',
        settingsSaved: 'Saved: the listener was rebuilt with the new settings.',
        settingsSaveFailed: 'Save failed',
        settingsSaveBlocked: 'This form cannot be saved yet',
        settingsListenWarning: 'Saving rebuilds the listener: live remote calls drop for about a second, and a failed bind rolls back.',
        settingsRestartRequired: 'Some changes only take full effect after a Host restart.',
        settingsNotListening: 'not listening',
        settingsListenError: 'Listener failed: {message}',
        settingsStateMissing: 'The Host returned no new state',
        listening: 'Listening on',
        plainHttp: 'plaintext HTTP',
        tlsShort: 'TLS',
        copyAddress: 'Copy address',
        settingsDirty: 'Unsaved',
        peersHint: 'Inbound peers hold a token for this machine; outbound peers are machines this one controls.',
        inboundHint: 'Peers holding a token for this machine',
        outboundHint: 'Peers this machine connects out to',
        pairHint: 'Mint a token that is shown once, then hand it to the other machine.',
        noSessionsNext: 'Open a Session in DSH, then come back here to decide whether peers may drive it.',
        noInboundNext: 'Choose “Pair a peer” to mint a token and hand it to the other machine.',
        noOutboundNext: 'Pair this machine’s token on the other side and it shows up here.',
        noDiscovery: 'No other machine heard on the LAN yet',
        noDiscoveryOff: 'LAN discovery is off',
        noDiscoveryNext: 'Turn on “LAN discovery (mDNS)” in the listener settings above; machines in the same subnet that also have it on appear here automatically.',
        discoveryFoundHint: 'Machines announcing themselves in this subnet; tokens are never broadcast, so pairing stays manual.',
        discoveryError: 'Discovery failed: {message}',
        wsExpand: 'Expand workspace',
        wsCollapse: 'Collapse workspace',
        wsSessions: '{count} sessions',
        wsSharedCount: '{count} shared',
        wsWholeShared: 'The whole workspace is shared; new sessions are shared automatically',
        wsShareHint: 'Sharing a workspace covers every session in it; no per-session switch needed.',
        wsEmpty: 'No sessions yet',
        wsEmptyNext: 'Share this workspace and new sessions in it are shared automatically.',
        wsOther: 'Other sessions',
        wsShareAll: 'Share the whole workspace',
        wsShareFailed: 'Workspace sharing failed',
        wsExpandAll: 'Expand all',
        wsCollapseAll: 'Collapse all',
      },
    }

    /** Host routes, resolved against the document so the app's mount point decides. */
    const ROUTE = {
      state: 'api/lan-bridge.state',
      share: 'api/lan-bridge.share',
      shareWorkspace: 'api/lan-bridge.shareWorkspace',
      pair: 'api/lan-bridge.pair',
      revoke: 'api/lan-bridge.revoke',
      settings: 'api/lan-bridge.settings',
    }

    /** Poll cadence while the section is on screen and the document visible. */
    const POLL_MS = 3000

    /** Second line of an inbound peer row keeps only this many characters. */
    const INLINE_LIMIT = 120

    // Every colour comes from a theme token, each with a mode-neutral literal
    // fallback, so a renamed token degrades to a plain surface instead of
    // dropping the declaration. Sizes and radii are literals on purpose: the
    // radii that vanished before were token references, not values.
    const CSS = [
      /* ---------- page: one column, the width the Settings dialog gives us ---------- */
      '.dslb-root{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:100%;max-width:720px;',
      'font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5;',
      'color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dslb-pageHead{display:flex;flex-direction:column;gap:2px}',
      '.dslb-pageTitle{margin:0;font-size:16px;line-height:24px;font-weight:500}',
      '.dslb-pageSub{margin:0;font-size:14px;line-height:22px;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',

      /* ---------- cards: the native Settings card material ---------- */
      '.dslb-card{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;padding:12px 14px;',
      'border:0.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1,rgba(128,128,128,.2)));',
      'border-radius:var(--dsw-radius-xl,12px);',
      'background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,transparent))}',
      '.dslb-cardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}',
      '.dslb-cardHeadMain{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dslb-cardTitle{margin:0;font-size:14px;line-height:22px;font-weight:500}',
      '.dslb-cardHint{margin:0;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dslb-cardActions{display:flex;align-items:center;gap:8px;flex:none}',

      /* ---------- 1. status card ---------- */
      '.dslb-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}',
      '.dslb-heroMain{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 220px}',
      '.dslb-heroName{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dslb-heroNameText{min-width:0;font-size:16px;line-height:24px;font-weight:500;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dslb-pill{flex:none;padding:1px 8px;border-radius:999px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-secondary,#5b6270);',
      'border:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));',
      'background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08))}',
      '.dslb-statusLine{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-statusText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dslb-liveDot{flex:none;width:8px;height:8px;border-radius:50%;',
      'background:var(--dsw-alias-state-success-primary,#2f9e6b)}',
      '.dslb-liveDot[data-state="idle"]{background:var(--dsw-alias-state-idle-primary,var(--dsw-alias-label-tertiary,#9aa0aa))}',
      '.dslb-liveDot[data-state="off"]{background:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dslb-heroSide{display:flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto}',
      '.dslb-addr{box-sizing:border-box;max-width:100%;padding:3px 8px;border-radius:var(--dsw-radius-sm,6px);',
      'background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));color:var(--dsw-alias-label-secondary,#5b6270);',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      /* ---------- buttons ---------- */
      '.dslb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;',
      'height:32px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));',
      'border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,#1f2329);',
      'font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;',
      'transition:background .12s ease,border-color .12s ease}',
      '.dslb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.dslb-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary,currentColor);',
      'outline-offset:1px}',
      '.dslb-btn:disabled{opacity:.5;cursor:default}',
      '.dslb-btn[data-tone="primary"]{border-color:transparent;',
      'color:var(--dsw-alias-label-primary-foreground,#fff);',
      'background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe))}',
      '.dslb-btn[data-tone="primary"]:hover:not(:disabled){',
      'background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4d6bfe))}',
      '.dslb-btn[data-tone="danger"]{border-color:transparent;background:transparent;',
      'color:var(--dsw-alias-state-error-primary,#d64545)}',
      '.dslb-btn[data-tone="danger"]:hover:not(:disabled){',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 10%,transparent)}',

      /* ---------- switch: native button semantics, no primitive dependency ---------- */
      '.dslb-switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;padding:0;border:none;',
      'border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa0aa) 45%,transparent);',
      'cursor:pointer;transition:background .12s ease}',
      '.dslb-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dslb-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:var(--dsw-alias-label-primary-foreground,#fff);',
      'box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .12s ease}',
      // Off: a light knob on the tinted track in both themes. The on-state knob
      // follows the brand fill, which is near-black in light and near-white in
      // dark, so it has to flip with the theme instead.
      '.dslb-switch[aria-checked="false"]::after{background:#fff}',
      '.dslb-switch[aria-checked="true"]::after{transform:translateX(16px)}',
      '.dslb-switch:disabled{cursor:default;opacity:.6}',
      '.dslb-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary,currentColor);',
      'outline-offset:2px}',

      /* ---------- form: labels above 32px inputs, two columns where it fits ---------- */
      '.dslb-formGrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 16px;min-width:0}',
      '.dslb-formStack{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.dslb-formField{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dslb-formLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-formHint{margin:0;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dslb-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;',
      'border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));',
      'border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-base,transparent);',
      'color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:13px;line-height:20px}',
      '.dslb-input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dslb-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary,currentColor);',
      'outline-offset:1px}',
      '.dslb-input:disabled{opacity:.6}',
      '.dslb-check{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;font-size:13px;line-height:20px;',
      'color:var(--dsw-alias-label-primary,#1f2329);cursor:pointer}',
      '.dslb-check input{flex:none;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',

      /* ---------- address / capability chips ---------- */
      '.dslb-chipsPick{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}',
      '.dslb-chipsPickLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-chipPick{box-sizing:border-box;padding:2px 9px;border-radius:999px;',
      'border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;',
      'color:var(--dsw-alias-label-secondary,#5b6270);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dslb-chipPick:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));',
      'color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dslb-chipPick[data-current="1"]{border-color:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 12%,transparent)}',
      '.dslb-chipPick:disabled{opacity:.5;cursor:default}',
      '.dslb-chips{display:flex;flex-wrap:wrap;gap:4px;min-width:0}',
      '.dslb-chip{padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));',
      'color:var(--dsw-alias-label-secondary,#5b6270);font-size:12px;line-height:18px}',

      /* ---------- rows: 44px, top-line separators, hover tint ---------- */
      '.dslb-list{display:flex;flex-direction:column;min-width:0}',
      '.dslb-row{display:flex;align-items:center;justify-content:space-between;gap:12px;box-sizing:border-box;',
      'min-height:44px;padding:10px 8px;border-radius:var(--dsw-radius-lg,8px);min-width:0}',
      '.dslb-list>.dslb-row+.dslb-row{border-top:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));',
      'border-radius:0}',
      '.dslb-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}',
      '.dslb-row[data-quiet="1"]:hover{background:transparent}',
      '.dslb-toggleRow{display:flex;align-items:center;justify-content:space-between;gap:12px;box-sizing:border-box;',
      'min-height:44px;padding:6px 0;min-width:0}',
      '.dslb-toggleRow+.dslb-toggleRow{border-top:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3))}',

      /* ---------- workspace groups: one collapsible row per workspace ---------- */
      '.dslb-wsGroup{display:flex;flex-direction:column;min-width:0}',
      '.dslb-wsGroup+.dslb-wsGroup{border-top:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
      '.dslb-wsHead{display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:44px;min-width:0}',
      '.dslb-wsToggle{display:flex;align-items:flex-start;gap:8px;flex:1 1 auto;min-width:0;min-height:44px;',
      'box-sizing:border-box;padding:9px 6px 8px;border:0;border-radius:var(--dsw-radius-lg,8px);background:none;',
      'color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dslb-wsToggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}',
      '.dslb-wsToggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary,currentColor);',
      'outline-offset:1px}',
      '.dslb-chevron{flex:none;margin-top:7px;width:0;height:0;border-left:5px solid currentColor;',
      'border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .12s ease}',
      '.dslb-chevron[data-open="1"]{transform:rotate(90deg)}',
      '.dslb-wsIdentity{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}',
      '.dslb-wsTitleLine{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.dslb-wsTitle{font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary,#1f2329);',
      'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dslb-wsPath{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-secondary,#5b6270);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dslb-wsMeta{flex:none;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dslb-wsHint{margin:0 0 4px;padding-left:22px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dslb-wsBody{display:flex;flex-direction:column;padding:0 0 4px 22px;min-width:0}',
      '.dslb-wsBody>.dslb-row+.dslb-row{border-top:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));',
      'border-radius:0}',
      '.dslb-wsBody>.dslb-empty{padding:4px 0 2px}',
      '.dslb-linkBtn{box-sizing:border-box;padding:2px 6px;border:0;border-radius:var(--dsw-radius-sm,6px);',
      'background:none;color:var(--dsw-alias-label-secondary,#5b6270);font:inherit;font-size:12px;line-height:18px;',
      'cursor:pointer}',
      '.dslb-linkBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));',
      'color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dslb-linkBtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary,currentColor);',
      'outline-offset:1px}',
      '.dslb-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}',
      '.dslb-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:14px;line-height:20px}',
      '.dslb-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dslb-desc{min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5b6270);',
      'overflow-wrap:anywhere}',
      '.dslb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
      'color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-dot{flex:none;width:8px;height:8px;border-radius:50%;',
      'background:var(--dsw-alias-label-tertiary,#9aa0aa)}',
      '.dslb-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary,#2f9e6b)}',
      '.dslb-dot[data-on="0"]{background:var(--dsw-alias-border-l2,rgba(128,128,128,.4))}',
      '.dslb-side{display:flex;align-items:center;gap:8px;flex:none}',

      /* ---------- sub-cards: inbound / outbound / pairing ---------- */
      '.dslb-subcard{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;padding:8px 10px;min-width:0;',
      'border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:var(--dsw-radius-lg,8px)}',
      '.dslb-subHead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
      '.dslb-subTitle{font-size:12px;line-height:18px;font-weight:500;',
      'color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-pairRow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;flex-wrap:wrap}',
      '.dslb-subHint{margin:0;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',

      /* ---------- one-time token ---------- */
      '.dslb-token{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:12px;min-width:0;',
      'border:0.5px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:var(--dsw-radius-lg,8px);',
      'background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06))}',
      '.dslb-tokenTitle{font-size:14px;line-height:20px;font-weight:500}',
      '.dslb-tokenRow{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dslb-tokenRow .dslb-input{flex:1 1 auto;min-width:0;text-overflow:ellipsis;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',

      /* ---------- sticky save bar ---------- */
      '.dslb-saveBar{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;justify-content:space-between;',
      'gap:12px;box-sizing:border-box;margin:0 -14px -12px;padding:10px 14px;',
      'border-top:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));',
      'border-radius:0 0 var(--dsw-radius-xl,12px) var(--dsw-radius-xl,12px);',
      'background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,transparent))}',
      '.dslb-saveMain{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dslb-dirty{flex:none;padding:1px 8px;border-radius:999px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-state-warn-primary,#c98a00);',
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c98a00) 12%,transparent)}',
      '.dslb-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,#2f9e6b)}',

      /* ---------- empty states, warnings, errors ---------- */
      '.dslb-empty{display:flex;flex-direction:column;gap:2px;padding:4px 0;min-width:0}',
      '.dslb-emptyTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-emptyNext{font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280))}',
      '.dslb-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#c98a00);',
      'overflow-wrap:anywhere}',
      '.dslb-alert{display:flex;align-items:center;justify-content:space-between;gap:12px;box-sizing:border-box;',
      'padding:8px 10px;border-radius:var(--dsw-radius-md,8px);',
      'border:0.5px solid var(--dsw-alias-state-error-primary,#d64545);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 8%,transparent);',
      'color:var(--dsw-alias-state-error-primary,#d64545);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dslb-loading{padding:4px 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b6270)}',
      '@media (prefers-reduced-motion:reduce){.dslb-switch::after,.dslb-switch,.dslb-btn{transition:none}}',
    ].join('')

    /** Reading of a thrown value; never throws itself. */
    function describe(error) {
      if (error instanceof Error) return error.message
      try {
        return String(error)
      } catch {
        return 'unknown error'
      }
    }

    /** A string field of an untrusted payload, or a fallback. */
    function text(value, fallback) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return fallback
    }

    /** An array field of an untrusted payload. */
    function list(value) {
      return Array.isArray(value) ? value : []
    }

    /** One entry of an untrusted array, or null when it is not an object. */
    function record(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    }

    /** Cut a long inline value without touching its start. */
    function clamp(value) {
      return value.length > INLINE_LIMIT ? `${value.slice(0, INLINE_LIMIT)}…` : value
    }

    /**
     * The editable listening settings, falling back to the live listener for a
     * Host that has not sent the `settings` block yet, so the form still opens
     * with the values the bridge is actually running.
     */
    function normalizeSettings(root, listen) {
      const settings = record(root.settings) ?? {}
      const tls = record(settings.tls)
      const port = typeof settings.port === 'number' && Number.isFinite(settings.port)
        ? settings.port
        : (typeof listen.port === 'number' && Number.isFinite(listen.port) ? listen.port : null)
      return {
        name: text(settings.name, text(record(root).name, '')),
        host: text(settings.host, text(listen.host, '')),
        port,
        insecureHttp: settings.insecureHttp === true,
        allowPeersToCreateSessions: settings.allowPeersToCreateSessions !== false,
        trustedHosts: list(settings.trustedHosts).map((value) => text(value, '')).filter((value) => value !== ''),
        tls: tls === null ? null : { certFile: text(tls.certFile, ''), keyFile: text(tls.keyFile, '') },
        discovery: settings.discovery === true,
      }
    }

    /** One session item, wherever it is listed (flat list or inside a workspace). */
    function projectSessions(entries) {
      return list(entries).map((entry) => {
        const session = record(entry)
        if (session === null) return null
        const sessionId = text(session.sessionId, '')
        if (sessionId === '') return null
        return {
          sessionId,
          title: text(session.title, ''),
          running: session.running === true,
          cwd: text(session.cwd, ''),
          shared: session.shared === true,
        }
      }).filter((session) => session !== null)
    }

    /**
     * Project the Host payload onto the panel's shape. Every field is optional
     * from the panel's point of view: a partial or malformed payload must
     * degrade, not crash the Settings surface.
     */
    function normalize(raw) {
      const root = record(raw) ?? {}
      const listen = record(root.listen) ?? {}
      const port = typeof listen.port === 'number' && Number.isFinite(listen.port)
        ? String(listen.port)
        : text(listen.port, '')
      // Top-level `discovery` is the mDNS agent's own status (distinct from
      // `settings.discovery`, the operator's switch). A Host older than the
      // panel has neither, so absence is a normal, quiet state.
      const agent = record(root.discovery)
      const agentError = agent === null ? '' : text(agent.error, '')
      const found = agent === null ? [] : list(agent.found).map((entry) => {
        const peer = record(entry)
        if (peer === null) return null
        const name = text(peer.name, '')
        const host = text(peer.host, '')
        const address = text(peer.address, '')
        if (name === '' && host === '' && address === '') return null
        const port = typeof peer.port === 'number' && Number.isFinite(peer.port) ? String(peer.port) : text(peer.port, '')
        return { name, host, address, port, version: text(peer.version, '') }
      }).filter((peer) => peer !== null)

      return {
        role: text(root.role, ''),
        name: text(root.name, ''),
        listen: {
          host: text(listen.host, ''),
          port,
          protocol: text(listen.protocol, ''),
          listening: typeof listen.listening === 'boolean' ? listen.listening : null,
          error: text(listen.error, ''),
        },
        settings: normalizeSettings(root, listen),
        addresses: list(root.addresses).map((value) => text(value, '')).filter((value) => value !== ''),
        restartRequired: root.restartRequired === true,
        discovery: {
          known: agent !== null,
          enabled: agent !== null && agent.enabled === true,
          listening: agent !== null && agent.listening === true,
          error: agentError,
          found,
        },
        inbound: list(root.inbound).map((entry) => {
          const peer = record(entry)
          if (peer === null) return null
          const name = text(peer.name, '')
          if (name === '') return null
          return {
            name,
            masked: text(peer.masked, ''),
            createdAt: typeof peer.createdAt === 'number' ? peer.createdAt : null,
            lastSeenAt: typeof peer.lastSeenAt === 'number' ? peer.lastSeenAt : null,
            capabilities: list(peer.capabilities).map((value) => text(value, '')).filter((value) => value !== ''),
          }
        }).filter((peer) => peer !== null),
        outbound: list(root.outbound).map((entry) => {
          const peer = record(entry)
          if (peer === null) return null
          const name = text(peer.name, '')
          if (name === '') return null
          return { name, url: text(peer.url, ''), reachable: peer.reachable === true }
        }).filter((peer) => peer !== null),
        sessions: projectSessions(root.sessions),
        // The grouped view. `null` means "this Host does not group" (an older
        // Host, or a Host that failed to enumerate workspaces) and the panel
        // falls back to the flat list — never to an error.
        workspaces: Array.isArray(root.workspaces)
          ? root.workspaces.map((entry) => {
            const group = record(entry)
            if (group === null) return null
            const workspaceId = text(group.workspaceId, '')
            if (workspaceId === '') return null
            return {
              workspaceId,
              title: text(group.title, ''),
              path: text(group.path, ''),
              shared: group.shared === true,
              sessions: projectSessions(group.sessions),
            }
          }).filter((group) => group !== null)
          : null,
      }
    }

    /**
     * One JSON round trip against the Host's UI route. A non-JSON body means
     * the request never reached the plugin route (an auth redirect, a proxy),
     * so it becomes an HTTP error instead of a half-parsed payload.
     */
    async function requestJson(path, init) {
      const options = init === undefined ? {} : init
      const url = new URL(path, document.baseURI)
      const headers = { accept: 'application/json' }
      if (options.body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(url.toString(), {
        method: options.method === undefined ? 'GET' : options.method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body: options.body,
        signal: options.signal,
      })
      const raw = await response.text()
      let body = null
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
      }
      if (!response.ok && record(body) === null) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
      }
      return { ok: response.ok, status: response.status, body }
    }

    /**
     * A refused mutation carries `error: { code, message, details }`. The
     * message is the Host's own sentence: the panel shows it verbatim rather
     * than translating it, and keeps the code for the error line.
     */
    function mutationError(body, status) {
      const failure = record(body.error)
      if (failure !== null) {
        const message = text(failure.message, '') || text(failure.code, '')
        const error = new Error(message === '' ? `HTTP ${status}`.trim() : message)
        error.code = text(failure.code, '')
        error.details = record(failure.details)
        return error
      }
      const message = text(body.error, '') || text(body.message, '')
      return new Error(message === '' ? `HTTP ${status}`.trim() : message)
    }

    /** The Host error code of a thrown mutation failure, when it has one. */
    function errorCode(error) {
      if (error === null || typeof error !== 'object') return ''
      return typeof error.code === 'string' ? error.code : ''
    }

    /** A mutation route answers `{ ok: true }`, or a readable failure. */
    async function mutate(path, payload, signal) {
      const response = await requestJson(path, {
        method: 'POST',
        body: JSON.stringify(payload),
        signal,
      })
      const body = record(response.body) ?? {}
      // A refusal always carries `error`. A success may answer with the
      // { ok: true, state } envelope or with the state object itself, and the
      // latter must not be mistaken for a failure.
      if (body.ok !== true && !Array.isArray(body.sessions)) throw mutationError(body, response.status)
      return body
    }

    /** Localized peer role of this machine. */
    function roleLabel(role, t) {
      if (role === 'listener') return t('roleListener')
      if (role === 'controller') return t('roleController')
      if (role === 'both') return t('roleBoth')
      return t('roleUnknown')
    }

    /** Localized capability name; unknown capabilities stay verbatim. */
    function capabilityLabel(capability, t) {
      if (capability === 'read') return t('capRead')
      if (capability === 'prompt') return t('capPrompt')
      if (capability === 'control') return t('capControl')
      if (capability === 'archive') return t('capArchive')
      if (capability === 'cancel') return t('capCancel')
      if (capability === 'wait') return t('capWait')
      if (capability === 'transcript') return t('capTranscript')
      if (capability === 'create') return t('capCreate')
      if (capability === 'collab') return t('capCollab')
      if (capability === 'approve') return t('capApprove')
      if (capability === 'rename') return t('capRename')
      if (capability === 'selectModel') return t('capSelectModel')
      return capability
    }

    /**
     * Capabilities a token can carry, in the order the pair form offers them.
     * Mirrors CAPABILITIES in lib/config.js; the Host stays the authority and
     * drops names it does not know.
     */
    const PAIR_CAPABILITIES = ['read', 'prompt', 'control', 'create', 'archive', 'collab', 'approve']

    /** What a fresh token gets when the operator changes nothing. */
    const DEFAULT_PAIR_CAPABILITIES = ['read', 'prompt']

    /** Relative age of a peer heartbeat, absolute beyond an hour. */
    function seenLabel(value, t) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('never')
      const delta = Date.now() - value
      if (!Number.isFinite(delta) || delta < 0) return t('justNow')
      const minutes = Math.floor(delta / 60000)
      if (minutes < 1) return t('justNow')
      if (minutes < 60) return t('minutesAgo', { count: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('hoursAgo', { count: hours })
      const at = new Date(value)
      return Number.isNaN(at.getTime()) ? t('empty') : at.toLocaleString()
    }

    /** Host and port as one address; a Host that is not listening renders empty. */
    function listenLabel(listen) {
      if (listen.host === '' && listen.port === '') return ''
      if (listen.host === '') return `:${listen.port}`
      return listen.port === '' ? listen.host : `${listen.host}:${listen.port}`
    }

    /* ---------------------------- listening settings ---------------------- */

    /** A bind address that only accepts local connections (or none yet). */
    function isLoopbackHost(host) {
      if (host === '') return true
      const value = host.toLowerCase()
      if (value === 'localhost' || value === '::1' || value === '[::1]') return true
      return /^127\./.test(value)
    }

    /** Trusted hosts as typed: commas or spaces separate, empties dropped. */
    function parseTrustedHosts(value) {
      return value.split(/[\s,]+/).map((entry) => entry.trim()).filter((entry) => entry !== '')
    }

    /** The draft the listening form edits, seeded from the Host's settings. */
    function draftFromSettings(settings) {
      const tls = settings.tls
      return {
        name: settings.name,
        host: settings.host,
        port: settings.port === null ? '' : String(settings.port),
        insecureHttp: settings.insecureHttp,
        allowPeersToCreateSessions: settings.allowPeersToCreateSessions,
        trustedHosts: settings.trustedHosts.join(', '),
        certFile: tls === null ? '' : tls.certFile,
        keyFile: tls === null ? '' : tls.keyFile,
        discovery: settings.discovery === true,
      }
    }

    /** Two drafts are equal when every edited field matches exactly. */
    function sameDraft(left, right) {
      return left.name === right.name
        && left.host === right.host
        && left.port === right.port
        && left.insecureHttp === right.insecureHttp
        && left.allowPeersToCreateSessions === right.allowPeersToCreateSessions
        && left.trustedHosts === right.trustedHosts
        && left.certFile === right.certFile
        && left.keyFile === right.keyFile
        && left.discovery === right.discovery
    }

    /** A stable key for one settings block, so a poll does not churn the form. */
    function settingsKeyOf(settings) {
      const tls = settings.tls
      return [
        settings.name,
        settings.host,
        settings.port === null ? '' : settings.port,
        settings.insecureHttp ? '1' : '0',
        settings.allowPeersToCreateSessions ? '1' : '0',
        settings.trustedHosts.join(','),
        tls === null ? '' : tls.certFile,
        tls === null ? '' : tls.keyFile,
        settings.discovery === true ? '1' : '0',
      ].join('\u0000')
    }

    /** A local translator when the framework did not compose one. */
    /**
     * The dictionary to fall back on when no translator is injected: the app
     * language from the document, Chinese otherwise (the contract language for
     * this plugin). Never throws when the document is absent.
     */
    function fallbackDictionary() {
      try {
        const lang = document.documentElement === null || document.documentElement === undefined
          ? ''
          : document.documentElement.lang
        if (typeof lang === 'string' && /^en\b/i.test(lang)) return DICT.en
      } catch (error) {
        // Tests and non-browser hosts have no document; Chinese is the default.
      }
      return DICT.zh
    }

    function translator(props) {
      if (props !== null && typeof props === 'object' && typeof props.t === 'function') return props.t
      const dictionary = fallbackDictionary()
      return (key, params) => {
        const template = String(dictionary[key] !== undefined ? dictionary[key] : key)
        if (params === null || typeof params !== 'object') return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (
          params[name] === undefined ? match : String(params[name])
        ))
      }
    }

    /**
     * The panel's data: one route read on mount, then a 3s poll that runs only
     * while the section is mounted and the document is visible, plus an
     * immediate read on focus and on return to the tab.
     */
    function useBridgeState() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '' })
      const mounted = React.useRef(true)
      const inflight = React.useRef(null)
      const queued = React.useRef(false)
      const abort = React.useRef(null)
      const onScreen = React.useRef(true)
      const rootRef = React.useRef(null)
      // Bumped whenever a mutation answers with a newer state, so a poll that
      // started before the mutation cannot overwrite it with a stale snapshot.
      const version = React.useRef(0)

      const load = React.useCallback(() => {
        // A poll tick never stacks behind a manual read or a slow route, but a
        // read asked for by an action (a toggle, a revoke) must still land, so
        // it waits for one more round instead of disappearing.
        if (inflight.current !== null) {
          queued.current = true
          return inflight.current
        }
        const controller = new AbortController()
        const startedAt = version.current
        abort.current = controller
        const run = requestJson(ROUTE.state, { signal: controller.signal })
          .then((response) => {
            const body = record(response.body)
            if (body === null) throw new Error(`HTTP ${response.status}`.trim())
            if (body.ok === false) throw new Error(text(body.error, '') || `HTTP ${response.status}`)
            // The read route sends the state object itself; a Host that wraps it
            // in the mutation envelope is accepted too.
            const payload = record(body.state) ?? body
            if (!mounted.current || version.current !== startedAt) return
            setState({ phase: 'ready', data: normalize(payload), error: '' })
          })
          .catch((error) => {
            if (!mounted.current || version.current !== startedAt) return
            if (error instanceof DOMException && error.name === 'AbortError') return
            const message = describe(error)
            // Keep the last good reading on screen: a failed poll is a stale
            // panel, not an empty one.
            setState((previous) => previous.phase === 'ready'
              ? { phase: 'ready', data: previous.data, error: message }
              : { phase: 'error', data: null, error: message })
          })
          .then(() => {
            inflight.current = null
            abort.current = null
            if (!mounted.current || !queued.current) return
            queued.current = false
            void load()
          })
        inflight.current = run
        return run
      }, [])

      // A Settings section can stay mounted while another section is on
      // screen, so "visible" is decided by what is actually visible, not only
      // by the document's own state.
      React.useEffect(() => {
        const node = rootRef.current
        if (node === null || typeof IntersectionObserver !== 'function') return undefined
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) onScreen.current = entry.isIntersecting
        })
        observer.observe(node)
        return () => {
          observer.disconnect()
        }
      })

      React.useEffect(() => {
        mounted.current = true
        void load()
        const tick = () => {
          if (document.visibilityState === 'visible' && onScreen.current) void load()
        }
        const onFocus = () => {
          void load()
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void load()
        }
        const timer = window.setInterval(tick, POLL_MS)
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          mounted.current = false
          if (abort.current !== null) {
            abort.current.abort()
            abort.current = null
          }
          window.clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])

      /**
       * Adopt a state a mutation already answered with, instead of paying a
       * second round trip: the Host sends the effective state back.
       */
      const applyState = React.useCallback((raw) => {
        const next = normalize(raw)
        version.current += 1
        if (mounted.current) setState({ phase: 'ready', data: next, error: '' })
        return next
      }, [])

      return { state, reload: load, rootRef, applyState }
    }

    /** The one-line status dot shared by Sessions and outbound peers. */
    function Dot(props) {
      return h('span', {
        className: 'dslb-dot',
        'data-on': props.on ? '1' : '0',
        'aria-hidden': 'true',
      })
    }

    /** A settings switch: native button semantics, no primitive dependency. */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'dslb-switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        'aria-busy': props.busy ? 'true' : undefined,
        disabled: props.disabled === true,
        title: props.title,
        onClick: props.onChange,
      })
    }

    /** A card: the one container every block of this page uses. */
    function Card(props) {
      return h('section', { className: 'dslb-card' },
        h('div', { className: 'dslb-cardHead' },
          h('div', { className: 'dslb-cardHeadMain' },
            h('h3', { className: 'dslb-cardTitle' }, props.title),
            props.hint === undefined || props.hint === ''
              ? null
              : h('p', { className: 'dslb-cardHint' }, props.hint)),
          props.actions === undefined ? null : h('div', { className: 'dslb-cardActions' }, props.actions)),
        props.children)
    }

    /** An empty state: what is missing, plus the next step that fills it. */
    function Empty(props) {
      return h('div', { className: 'dslb-empty' },
        h('span', { className: 'dslb-emptyTitle' }, props.title),
        props.next === undefined || props.next === ''
          ? null
          : h('span', { className: 'dslb-emptyNext' }, props.next))
    }

    /**
     * 1. The status card: what this machine looks like to the LAN right now —
     * its advertised name, the role it plays, whether the listener is up and
     * on which surface, and the address to hand to the other machine.
     */
    function StatusHero(props) {
      const { data, t } = props
      const listen = data.listen
      const address = listenLabel(listen)
      const live = listen.protocol === '' || address === '' ? address : `${listen.protocol}://${address}`
      const down = listen.listening === false
      const tls = data.settings.tls !== null || listen.protocol === 'https'
      // Plaintext is only worth flagging when the listener is actually reachable
      // from the LAN: loopback traffic never leaves this machine.
      const exposure = tls ? t('tlsShort') : (isLoopbackHost(listen.host) ? '' : t('plainHttp'))
      const parts = []
      if (!down && listen.listening === true) parts.push(t('listening'))
      if (!down && address !== '') parts.push(address)
      if (!down && exposure !== '') parts.push(exposure)
      const line = down
        ? (address === '' ? t('settingsNotListening') : `${address} · ${t('settingsNotListening')}`)
        : (parts.length === 0 ? t('empty') : parts.join(' · '))
      const state = down ? 'off' : (listen.listening === true ? 'on' : 'idle')
      const [copyState, setCopyState] = React.useState('idle')

      const copy = () => {
        const value = live === '' ? address : live
        if (value === '') return
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
          setCopyState('failed')
          return
        }
        void navigator.clipboard.writeText(value)
          .then(() => setCopyState('done'))
          .catch(() => setCopyState('failed'))
      }

      return h('section', { className: 'dslb-card', 'aria-label': t('thisMachine') },
        h('div', { className: 'dslb-hero' },
          h('div', { className: 'dslb-heroMain' },
            h('div', { className: 'dslb-heroName' },
              h('span', { className: 'dslb-heroNameText', title: t('peerName') },
                data.name === '' ? t('empty') : data.name),
              h('span', { className: 'dslb-pill', title: t('role') }, roleLabel(data.role, t))),
            h('div', {
              className: 'dslb-statusLine',
              role: 'group',
              'aria-label': `${t('listen')}: ${line}`,
            },
              h('span', { className: 'dslb-liveDot', 'data-state': state, 'aria-hidden': 'true' }),
              h('span', { className: 'dslb-statusText', title: line }, line))),
          h('div', { className: 'dslb-heroSide' },
            live === '' ? null : h('span', { className: 'dslb-addr', title: live }, live),
            h('button', {
              type: 'button',
              className: 'dslb-btn',
              'aria-label': t('copyAddress'),
              disabled: live === '',
              onClick: copy,
            }, copyState === 'done' ? t('copied') : (copyState === 'failed' ? t('copyFailed') : t('copy'))))),
        listen.error === ''
          ? null
          : h('p', { className: 'dslb-warn', role: 'alert' },
            t('settingsListenError', { message: listen.error })))
    }

    /**
     * The listening form. The bridge's bind address is decided here, not in
     * cordis.patch.yml: saving rebuilds the listener immediately. The rules the
     * Host enforces are mirrored up front (a non-loopback bind without TLS
     * needs the explicit plaintext consent; certificate and key are
     * all-or-nothing; the port is 0-65535), so a save the Host would refuse is
     * usually never sent, and any refusal that does arrive is shown verbatim.
     */
    function ListenSettings(props) {
      const { data, t, applyState } = props
      const settings = data.settings
      const initial = draftFromSettings(settings)
      const [draft, setDraft] = React.useState(initial)
      const [baseline, setBaseline] = React.useState(initial)
      const [saving, setSaving] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [saved, setSaved] = React.useState(false)

      const draftRef = React.useRef(draft)
      draftRef.current = draft
      const baselineRef = React.useRef(baseline)
      baselineRef.current = baseline
      const settingsKey = settingsKeyOf(settings)
      const settingsKeyRef = React.useRef(settingsKey)
      const savedTimer = React.useRef(0)

      React.useEffect(() => () => {
        if (savedTimer.current !== 0) window.clearTimeout(savedTimer.current)
      }, [])

      // A poll can deliver settings another browser changed. Follow them, but
      // never overwrite an edit this operator has not saved yet.
      React.useEffect(() => {
        if (settingsKey === settingsKeyRef.current) return
        settingsKeyRef.current = settingsKey
        const next = draftFromSettings(settings)
        const previous = baselineRef.current
        baselineRef.current = next
        setBaseline(next)
        if (sameDraft(draftRef.current, previous)) setDraft(next)
      })

      const update = (field, value) => {
        setFailure(null)
        setSaved(false)
        setDraft((previous) => ({ ...previous, [field]: value }))
      }

      const name = draft.name.trim()
      const host = draft.host.trim()
      const portText = draft.port.trim()
      const portNumber = /^\d+$/.test(portText) ? Number(portText) : NaN
      const portValid = Number.isInteger(portNumber) && portNumber >= 0 && portNumber <= 65535
      const certFile = draft.certFile.trim()
      const keyFile = draft.keyFile.trim()
      const tlsHalf = (certFile === '') !== (keyFile === '')
      const tlsPresent = certFile !== '' && keyFile !== ''
      const hostMissing = host === ''
      const outward = !isLoopbackHost(host)
      // The Host refuses an outward bind with neither TLS nor the plaintext
      // acknowledgment. Say so pre-emptively, but leave the button live: a
      // refusal costs nothing and the Host's own sentence teaches the rule.
      const insecureWarn = outward && !tlsPresent && !draft.insecureHttp
      const nameMissing = name === ''
      const nameTooLong = name.length > 64
      const problem = nameMissing
        ? 'settingsNameMissing'
        : (nameTooLong ? 'settingsNameTooLong' : (hostMissing
          ? 'settingsHostMissing'
          : (!portValid ? 'settingsPortInvalid' : (tlsHalf ? 'settingsTlsHalf' : ''))))
      const dirty = !sameDraft(draft, baseline)
      // Only a different address or port rebuilds the listener; toggling a
      // permission or the Host allowlist does not.
      const listenChanged = host !== baseline.host.trim() || portText !== baseline.port.trim()
      const nameLiveChanged = name !== baseline.name.trim() && name !== ''
      const canSave = dirty && problem === '' && !saving

      const save = () => {
        if (saving || problem !== '' || !dirty) return
        const payload = {
          name,
          host,
          port: portNumber,
          insecureHttp: draft.insecureHttp,
          discovery: draft.discovery,
          allowPeersToCreateSessions: draft.allowPeersToCreateSessions,
          trustedHosts: parseTrustedHosts(draft.trustedHosts),
          tls: tlsPresent ? { certFile, keyFile } : null,
        }
        setSaving(true)
        setFailure(null)
        void mutate(ROUTE.settings, payload)
          .then((body) => {
            const answered = record(body.state) ?? (Array.isArray(body.sessions) ? body : null)
            if (answered === null) throw new Error(t('settingsStateMissing'))
            const applied = applyState(answered)
            // Rebase on what the Host says is effective now (it may clamp a
            // port, keep a value, or echo the TLS pair) instead of on the draft.
            const rebased = draftFromSettings(applied.settings)
            baselineRef.current = rebased
            settingsKeyRef.current = settingsKeyOf(applied.settings)
            setBaseline(rebased)
            setDraft(rebased)
            setSaved(true)
            if (savedTimer.current !== 0) window.clearTimeout(savedTimer.current)
            savedTimer.current = window.setTimeout(() => {
              savedTimer.current = 0
              setSaved(false)
            }, 4000)
          })
          .catch((error) => {
            setFailure({ message: describe(error), code: errorCode(error) })
          })
          .finally(() => {
            setSaving(false)
          })
      }

      const hostChoices = []
      for (const candidate of ['127.0.0.1', '0.0.0.0'].concat(data.addresses)) {
        if (candidate === '' || hostChoices.indexOf(candidate) !== -1) continue
        hostChoices.push(candidate)
      }
      const assigned = data.listen.listening === true ? data.listen.port : ''
      const showAssigned = settings.port === 0 && assigned !== ''
      const assignedDraft = draft.port.trim() === '0' && assigned !== ''

      // 2. The listener card. Every rule the Host enforces is mirrored inline,
      // but only the three that make a save meaningless (no name, no address, a
      // half-filled TLS pair, a port that is not a port) disable the button; a
      // plaintext bind is allowed to be attempted so the Host's own sentence is
      // what explains the refusal.
      return h('section', { className: 'dslb-card' },
        h('div', { className: 'dslb-cardHead' },
          h('div', { className: 'dslb-cardHeadMain' },
            h('h3', { className: 'dslb-cardTitle' }, t('settingsTitle')),
            h('p', { className: 'dslb-cardHint' }, t('settingsHint')))),

        h('div', { className: 'dslb-formStack' },
          h('label', { className: 'dslb-formField' },
            h('span', { className: 'dslb-formLabel' }, t('settingsName')),
            h('input', {
              className: 'dslb-input',
              value: draft.name,
              maxLength: 64,
              spellCheck: false,
              disabled: saving,
              'aria-label': t('settingsName'),
              onChange: (event) => update('name', event.currentTarget.value),
            }),
            h('span', { className: 'dslb-formHint' }, t('settingsNameHint')),
            nameLiveChanged
              ? h('span', { className: 'dslb-formHint' }, t('settingsNameLive'))
              : null)),

        h('div', { className: 'dslb-formGrid' },
          h('div', { className: 'dslb-formField' },
            h('span', { className: 'dslb-formLabel' }, t('settingsHost')),
            h('input', {
              className: 'dslb-input',
              value: draft.host,
              spellCheck: false,
              disabled: saving,
              'aria-label': t('settingsHost'),
              onChange: (event) => update('host', event.currentTarget.value),
            }),
            h('span', { className: 'dslb-formHint' }, t('settingsHostHint'))),
          h('label', { className: 'dslb-formField' },
            h('span', { className: 'dslb-formLabel' }, t('settingsPort')),
            h('input', {
              className: 'dslb-input',
              value: draft.port,
              inputMode: 'numeric',
              spellCheck: false,
              disabled: saving,
              'aria-label': t('settingsPort'),
              onChange: (event) => update('port', event.currentTarget.value),
            }),
            h('span', { className: 'dslb-formHint' }, t('settingsPortHint')),
            assignedDraft || showAssigned
              ? h('span', { className: 'dslb-formHint' }, t('settingsPortAuto', { port: assigned }))
              : null)),

        h('div', { className: 'dslb-chipsPick', 'aria-label': t('settingsAddresses') },
          h('span', { className: 'dslb-chipsPickLabel' }, t('settingsAddresses')),
          hostChoices.map((value) => h('button', {
            key: value,
            type: 'button',
            className: 'dslb-chipPick',
            'data-current': value === host ? '1' : '0',
            'aria-pressed': value === host ? 'true' : 'false',
            disabled: saving,
            onClick: () => update('host', value),
          }, value))),

        h('div', { className: 'dslb-list' },
          h('div', { className: 'dslb-toggleRow' },
            h('div', { className: 'dslb-main' },
              h('div', { className: 'dslb-title' }, t('settingsAllowCreate')),
              h('div', { className: 'dslb-desc' }, t('settingsAllowCreateHint'))),
            h(Switch, {
              checked: draft.allowPeersToCreateSessions,
              label: t('settingsAllowCreate'),
              disabled: saving,
              onChange: () => update('allowPeersToCreateSessions', !draft.allowPeersToCreateSessions),
            })),
          h('div', { className: 'dslb-toggleRow' },
            h('div', { className: 'dslb-main' },
              h('div', { className: 'dslb-title' }, t('settingsDiscovery')),
              h('div', { className: 'dslb-desc' }, t('settingsDiscoveryHint'))),
            h(Switch, {
              checked: draft.discovery,
              label: t('settingsDiscovery'),
              disabled: saving,
              onChange: () => update('discovery', !draft.discovery),
            }))),

        h('div', { className: 'dslb-formStack' },
          h('label', { className: 'dslb-formField' },
            h('span', { className: 'dslb-formLabel' }, t('settingsTrustedHosts')),
            h('input', {
              className: 'dslb-input',
              value: draft.trustedHosts,
              placeholder: t('settingsTrustedHostsPlaceholder'),
              spellCheck: false,
              disabled: saving,
              'aria-label': t('settingsTrustedHosts'),
              onChange: (event) => update('trustedHosts', event.currentTarget.value),
            }),
            h('span', { className: 'dslb-formHint' }, t('settingsTrustedHostsHint')))),

        h('div', { className: 'dslb-formGrid' },
          h('label', { className: 'dslb-formField' },
            h('span', { className: 'dslb-formLabel' }, t('settingsTlsCert')),
            h('input', {
              className: 'dslb-input',
              value: draft.certFile,
              spellCheck: false,
              disabled: saving,
              'aria-label': t('settingsTlsCert'),
              onChange: (event) => update('certFile', event.currentTarget.value),
            })),
          h('label', { className: 'dslb-formField' },
            h('span', { className: 'dslb-formLabel' }, t('settingsTlsKey')),
            h('input', {
              className: 'dslb-input',
              value: draft.keyFile,
              spellCheck: false,
              disabled: saving,
              'aria-label': t('settingsTlsKey'),
              onChange: (event) => update('keyFile', event.currentTarget.value),
            }))),
        h('p', { className: 'dslb-formHint' }, t('settingsTlsHint')),

        h('label', { className: 'dslb-check' },
          h('input', {
            type: 'checkbox',
            checked: draft.insecureHttp,
            disabled: saving,
            onChange: (event) => update('insecureHttp', event.currentTarget.checked),
          }),
          h('span', null, t('settingsInsecure'))),
        insecureWarn
          ? h('p', { className: 'dslb-warn', role: 'note' }, t('settingsInsecureWarning'))
          : null,

        problem === '' ? null : h('p', { className: 'dslb-warn', role: 'note' }, t(problem)),
        listenChanged
          ? h('p', { className: 'dslb-warn', role: 'note' }, t('settingsListenWarning'))
          : null,
        data.restartRequired
          ? h('p', { className: 'dslb-warn', role: 'note' }, t('settingsRestartRequired'))
          : null,

        failure === null
          ? null
          : h('div', { className: 'dslb-alert', role: 'alert' },
            h('span', null, failure.code === ''
              ? `${t('settingsSaveFailed')}: ${failure.message}`
              : `${t('settingsSaveFailed')}: ${failure.message} · ${failure.code}`),
            h('button', {
              type: 'button',
              className: 'dslb-btn',
              onClick: () => setFailure(null),
            }, t('dismiss'))),

        h('div', { className: 'dslb-saveBar' },
          h('div', { className: 'dslb-saveMain' },
            dirty ? h('span', { className: 'dslb-dirty' }, t('settingsDirty')) : null,
            saved && !dirty
              ? h('span', { className: 'dslb-ok', role: 'status' }, t('settingsSaved'))
              : null),
          h('button', {
            type: 'button',
            className: 'dslb-btn',
            'data-tone': 'primary',
            disabled: !canSave,
            title: canSave ? undefined : t('settingsSaveBlocked'),
            onClick: save,
          }, saving ? t('settingsSaving') : t('settingsSave'))))
    }

    /**
     * One Session row: identity on the left, the sharing switch on the right.
     * The switch is optimistic and reverts when the route refuses. `locked`
     * means the owning workspace is shared as a whole, so the effective value
     * cannot be turned off per session.
     */
    function SessionRow(props) {
      const { session, shared, pending, failure, locked, t, onToggle } = props
      const title = session.title === '' ? session.sessionId : session.title
      const cwd = session.cwd === '' ? t('empty') : session.cwd
      return h('div', { className: 'dslb-row' },
        h('div', { className: 'dslb-main' },
          h('div', { className: 'dslb-title' },
            h(Dot, { on: session.running }),
            h('span', { className: 'dslb-name', title: title }, title),
            h('span', { className: 'dslb-desc' }, session.running ? t('running') : t('idle'))),
          h('div', { className: 'dslb-desc', title: cwd }, clamp(cwd)),
          failure === '' ? null : h('div', { className: 'dslb-desc', role: 'alert' }, failure)),
        h('div', { className: 'dslb-side' },
          h(Switch, {
            checked: locked ? true : shared,
            busy: pending,
            disabled: pending || locked,
            label: t('share'),
            title: locked ? t('wsWholeShared') : `${t('share')} · ${title}`,
            onChange: () => onToggle(session, !shared),
          })))
    }

    /**
     * One workspace: a collapsible header (chevron, name, mono path, counts,
     * whole-workspace switch) over its session rows. A workspace with no
     * sessions is still listed — an operator can share it for future sessions.
     */
    function WorkspaceGroup(props) {
      const {
        group, open, shared, pending, failure,
        overrides, sessionPending, sessionFailures,
        t, onToggleOpen, onToggleWorkspace, onToggleSession,
      } = props
      const label = group.title !== ''
        ? group.title
        : (group.workspaceId === 'ungrouped'
          ? t('wsOther')
          : (group.path !== '' ? group.path : group.workspaceId))
      const effective = (session) => (Object.prototype.hasOwnProperty.call(overrides, session.sessionId)
        ? overrides[session.sessionId]
        : session.shared)
      const sharedCount = group.sessions.filter((session) => effective(session)).length
      const meta = [t('wsSessions', { count: group.sessions.length })]
      if (sharedCount > 0) meta.push(t('wsSharedCount', { count: sharedCount }))
      return h('div', { className: 'dslb-wsGroup' },
        h('div', { className: 'dslb-wsHead' },
          h('button', {
            type: 'button',
            className: 'dslb-wsToggle',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': open ? t('wsCollapse') : t('wsExpand'),
            onClick: () => onToggleOpen(group.workspaceId),
          },
            h('span', { className: 'dslb-chevron', 'data-open': open ? '1' : '0', 'aria-hidden': 'true' }),
            h('span', { className: 'dslb-wsIdentity' },
              h('span', { className: 'dslb-wsTitleLine' },
                h('span', { className: 'dslb-wsTitle', title: label }, label),
                h('span', { className: 'dslb-wsMeta' }, meta.join(' · '))),
              group.path === '' ? null : h('span', { className: 'dslb-wsPath', title: group.path }, clamp(group.path)))),
          h('span', { className: 'dslb-side' },
            h(Switch, {
              checked: shared,
              busy: pending,
              disabled: pending,
              label: t('wsShareAll'),
              title: t('wsShareHint'),
              onChange: () => onToggleWorkspace(group, !shared),
            }))),
        failure === '' ? null : h('div', { className: 'dslb-wsHint', role: 'alert' }, failure),
        shared ? h('div', { className: 'dslb-wsHint' }, t('wsWholeShared')) : null,
        open
          ? h('div', { className: 'dslb-wsBody' },
            group.sessions.length === 0
              ? h(Empty, { title: t('wsEmpty'), next: t('wsEmptyNext') })
              : group.sessions.map((session) => h(SessionRow, {
                key: session.sessionId,
                session,
                shared: effective(session),
                pending: sessionPending[session.sessionId] === true,
                failure: text(sessionFailures[session.sessionId], ''),
                locked: shared,
                t,
                onToggle: onToggleSession,
              })))
          : null)
    }

    /**
     * 4. Session sharing: the panel's main decision surface. When the Host
     * groups Sessions by workspace the card renders one collapsible group per
     * workspace (all collapsed to start); an older Host without `workspaces`
     * keeps the flat list. Either way a toggle is optimistic and reverts,
     * naming the Host's reason in place.
     */
    function Sessions(props) {
      const {
        data, t, overrides, pending, failures,
        wsOverrides, wsPending, wsFailures, openGroups,
        onToggle, onToggleWorkspace, onToggleOpen, onToggleAll,
      } = props
      const flat = () => h('div', { className: 'dslb-list' }, data.sessions.map((session) => {
        const id = session.sessionId
        const shared = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : session.shared
        return h(SessionRow, {
          key: id,
          session,
          shared,
          pending: pending[id] === true,
          failure: text(failures[id], ''),
          locked: false,
          t,
          onToggle,
        })
      }))
      if (data.workspaces === null) {
        return h(Card, { title: t('sessions'), hint: t('sessionsHint') },
          data.sessions.length === 0
            ? h(Empty, { title: t('noSessions'), next: t('noSessionsNext') })
            : flat())
      }
      // The synthesized "ungrouped" bucket is noise while it is empty; a real
      // workspace with no sessions is still worth showing (share it up front).
      const groups = data.workspaces.filter((group) => !(group.workspaceId === 'ungrouped' && group.sessions.length === 0))
      const allOpen = groups.length > 0 && groups.every((group) => openGroups[group.workspaceId] === true)
      return h(Card, {
        title: t('sessions'),
        hint: t('sessionsHint'),
        actions: groups.length === 0
          ? null
          : h('button', {
            type: 'button',
            className: 'dslb-linkBtn',
            'aria-expanded': allOpen ? 'true' : 'false',
            onClick: () => onToggleAll(!allOpen),
          }, allOpen ? t('wsCollapseAll') : t('wsExpandAll')),
      },
        groups.length === 0
          ? h(Empty, { title: t('noSessions'), next: t('noSessionsNext') })
          : h('div', { className: 'dslb-list' }, groups.map((group) => {
            const id = group.workspaceId
            const shared = Object.prototype.hasOwnProperty.call(wsOverrides, id) ? wsOverrides[id] : group.shared
            return h(WorkspaceGroup, {
              key: id,
              group,
              open: openGroups[id] === true,
              shared,
              pending: wsPending[id] === true,
              failure: text(wsFailures[id], ''),
              overrides,
              sessionPending: pending,
              sessionFailures: failures,
              t,
              onToggleOpen,
              onToggleWorkspace,
              onToggleSession: onToggle,
            })
          })))
    }

    /** One inbound peer: masked token, heartbeat, capabilities, revocation. */
    function InboundRow(props) {
      const { peer, t, confirming, busy, failure, onAsk, onCancel, onRevoke } = props
      const seen = seenLabel(peer.lastSeenAt, t)
      const detail = peer.masked === '' ? seen : `${peer.masked} · ${seen}`
      return h('div', { className: 'dslb-row', 'data-quiet': '1' },
        h('div', { className: 'dslb-main' },
          h('div', { className: 'dslb-title' }, h('span', { className: 'dslb-name' }, peer.name)),
          h('div', { className: 'dslb-desc', title: peer.masked === '' ? '' : peer.masked },
            h('span', { className: 'dslb-mono' }, detail)),
          peer.capabilities.length === 0 ? null : h('div', { className: 'dslb-chips' },
            peer.capabilities.map((capability, index) => h('span', {
              key: `${capability}-${index}`,
              className: 'dslb-chip',
            }, capabilityLabel(capability, t)))),
          failure === '' ? null : h('div', { className: 'dslb-desc', role: 'alert' }, failure)),
        h('div', { className: 'dslb-side' },
          confirming
            ? h(React.Fragment, null,
              h('button', {
                type: 'button',
                className: 'dslb-btn',
                'data-tone': 'danger',
                disabled: busy,
                title: t('revokeHint'),
                onClick: () => onRevoke(peer),
              }, t('revokeConfirm')),
              h('button', {
                type: 'button',
                className: 'dslb-btn',
                disabled: busy,
                onClick: onCancel,
              }, t('cancel')))
            : h('button', {
              type: 'button',
              className: 'dslb-btn',
              'data-tone': 'danger',
              // One extra click guards a token that cannot be reissued.
              onClick: onAsk,
            }, t('revoke'))))
    }

    /** One outbound peer: configured URL and the last probe result. */
    function OutboundRow(props) {
      const { peer, t } = props
      return h('div', { className: 'dslb-row', 'data-quiet': '1' },
        h('div', { className: 'dslb-main' },
          h('div', { className: 'dslb-title' }, h('span', { className: 'dslb-name' }, peer.name)),
          h('div', { className: 'dslb-desc', title: peer.url },
            h('span', { className: 'dslb-mono' }, peer.url === '' ? t('empty') : peer.url))),
        h('div', { className: 'dslb-side' },
          h(Dot, { on: peer.reachable }),
          h('span', { className: 'dslb-desc' }, peer.reachable ? t('reachable') : t('unreachable'))))
    }

    /**
     * Pairing: a name becomes a one-time token. The token is shown once and
     * only in memory here; leaving the section discards it.
     */
    function Pairing(props) {
      const { t, reload } = props
      const [open, setOpen] = React.useState(false)
      const [name, setName] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [issued, setIssued] = React.useState(null)
      const [caps, setCaps] = React.useState(DEFAULT_PAIR_CAPABILITIES)
      const [copyState, setCopyState] = React.useState('idle')
      const inputRef = React.useRef(null)
      const tokenRef = React.useRef(null)

      React.useEffect(() => {
        if (!open || inputRef.current === null) return
        inputRef.current.focus()
      }, [open])

      /**
       * Toggle one capability, keeping the canonical order so a token's
       * capabilities read the same way every time it is issued.
       */
      const toggle = (capability) => {
        setCaps((current) => (current.includes(capability)
          ? current.filter((value) => value !== capability)
          : PAIR_CAPABILITIES.filter((value) => value === capability || current.includes(value))))
      }

      const submit = () => {
        const trimmed = name.trim()
        if (trimmed === '') {
          setFailure(t('pairNameRequired'))
          return
        }
        // A token with no capability can do nothing; refuse instead of minting
        // a credential that only looks useful.
        if (caps.length === 0) {
          setFailure(t('pairCapNone'))
          return
        }
        setBusy(true)
        setFailure('')
        void mutate(ROUTE.pair, { name: trimmed, capabilities: caps })
          .then((body) => {
            const token = text(body.token, '')
            // The contract promises the token exactly once: no token means the
            // peer was created but cannot be handed over, and saying so is
            // better than offering an empty field.
            if (token === '') throw new Error(t('tokenMissing'))
            setIssued({ name: trimmed, token, capabilities: caps.slice() })
            void reload()
            setCopyState('idle')
            setName('')
            setOpen(false)
          })
          .catch((error) => {
            setFailure(`${t('pairFailed')}: ${describe(error)}`)
          })
          .finally(() => {
            setBusy(false)
          })
      }

      const copy = () => {
        if (issued === null || issued.token === '') return
        const fallback = () => {
          const input = tokenRef.current
          if (input !== null && typeof input.select === 'function') {
            input.select()
            setCopyState('failed')
          } else {
            setCopyState('failed')
          }
        }
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
          fallback()
          return
        }
        void navigator.clipboard.writeText(issued.token)
          .then(() => setCopyState('done'))
          .catch(() => fallback())
      }

      const dismiss = () => {
        setIssued(null)
        setCopyState('idle')
      }

      const startPairing = () => {
        setOpen(true)
        setFailure('')
      }
      return h('div', { className: 'dslb-subcard' },
        open || issued !== null
          ? h('div', { className: 'dslb-subHead' },
            h('span', { className: 'dslb-subTitle' }, t('pair')))
          : h('div', { className: 'dslb-pairRow' },
            h('p', { className: 'dslb-subHint' }, t('pairHint')),
            h('button', {
              type: 'button',
              className: 'dslb-btn',
              onClick: startPairing,
            }, t('pair'))),

        issued === null ? null : h('div', { className: 'dslb-token' },
          h('div', { className: 'dslb-tokenTitle' }, t('tokenTitle')),
          h('div', { className: 'dslb-desc' }, t('tokenFor', { name: issued.name })),
          h('div', { className: 'dslb-desc' }, t('pairCapsLine', {
            caps: issued.capabilities.map((capability) => capabilityLabel(capability, t)).join(' / '),
          })),
          h('div', { className: 'dslb-tokenRow' },
            h('input', {
              ref: tokenRef,
              className: 'dslb-input',
              readOnly: true,
              value: issued.token,
              spellCheck: false,
              onFocus: (event) => event.currentTarget.select(),
              'aria-label': t('tokenTitle'),
            }),
            h('button', { type: 'button', className: 'dslb-btn', onClick: copy },
              copyState === 'done' ? t('copied') : t('copy'))),
          h('p', { className: 'dslb-warn', role: 'note' }, t('tokenOnce')),
          copyState === 'failed'
            ? h('p', { className: 'dslb-warn', role: 'alert' }, t('copyFailed'))
            : null,
          h('div', { className: 'dslb-side' },
            h('button', { type: 'button', className: 'dslb-btn', onClick: dismiss }, t('dismiss')))),

        failure === '' ? null : h('div', { className: 'dslb-alert', role: 'alert' },
          h('span', null, failure),
          h('button', {
            type: 'button',
            className: 'dslb-btn',
            onClick: () => setFailure(''),
          }, t('dismiss'))),

        open
          ? h('div', { className: 'dslb-formStack' },
            h('div', { className: 'dslb-formField' },
              h('span', { className: 'dslb-formLabel' }, t('pairPlaceholder')),
              h('input', {
                ref: inputRef,
                className: 'dslb-input',
                value: name,
                placeholder: t('pairPlaceholder'),
                'aria-label': t('pairPlaceholder'),
                spellCheck: false,
                disabled: busy,
                onChange: (event) => setName(event.currentTarget.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit()
                  if (event.key === 'Escape' && !busy) setOpen(false)
                },
              })),
            h('div', { className: 'dslb-chipsPick', 'aria-label': t('pairCapabilities') },
              h('span', { className: 'dslb-chipsPickLabel' }, t('pairCapabilities')),
              PAIR_CAPABILITIES.map((capability) => h('button', {
                key: capability,
                type: 'button',
                className: 'dslb-chipPick',
                'data-current': caps.includes(capability) ? '1' : '0',
                'aria-pressed': caps.includes(capability) ? 'true' : 'false',
                disabled: busy,
                onClick: () => toggle(capability),
              }, capabilityLabel(capability, t)))),
            h('p', { className: 'dslb-formHint' }, t('pairCapHint')),
            h('div', { className: 'dslb-side' },
              h('button', {
                type: 'button',
                className: 'dslb-btn',
                'data-tone': 'primary',
                disabled: busy,
                onClick: submit,
              }, t('pairSubmit')),
              h('button', {
                type: 'button',
                className: 'dslb-btn',
                disabled: busy,
                onClick: () => {
                  setOpen(false)
                  setFailure('')
                },
              }, t('pairCancel'))))
          : null)

    }

    /** The peer inventory and everything that changes it. */
    function Peers(props) {
      const { data, t } = props
      const [confirming, setConfirming] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [failure, setFailure] = React.useState({})
      const { reload } = props

      const revoke = (peer) => {
        setBusy(peer.name)
        setFailure((previous) => ({ ...previous, [peer.name]: '' }))
        void mutate(ROUTE.revoke, { name: peer.name })
          .then(() => {
            setConfirming('')
            return reload()
          })
          .catch((error) => {
            setFailure((previous) => ({ ...previous, [peer.name]: `${t('revokeFailed')}: ${describe(error)}` }))
          })
          .finally(() => {
            setBusy('')
          })
      }

      // 3. Peer inventory. Issuing and revoking credentials lives here because
      // both sides of a pairing are one decision, and the token is only ever on
      // screen in this card.
      return h(Card, { title: t('peers'), hint: t('peersHint') },
        h('div', { className: 'dslb-subcard' },
          h('div', { className: 'dslb-subHead' },
            h('span', { className: 'dslb-subTitle' }, t('inbound')),
            h('span', { className: 'dslb-subHint' }, t('inboundHint'))),
          data.inbound.length === 0
            ? h(Empty, { title: t('noInbound'), next: t('noInboundNext') })
            : h('div', { className: 'dslb-list' }, data.inbound.map((peer) => h(InboundRow, {
              key: peer.name,
              peer,
              t,
              confirming: confirming === peer.name,
              busy: busy === peer.name,
              failure: text(failure[peer.name], ''),
              onAsk: () => setConfirming(peer.name),
              onCancel: () => setConfirming(''),
              onRevoke: revoke,
            })))),
        h('div', { className: 'dslb-subcard' },
          h('div', { className: 'dslb-subHead' },
            h('span', { className: 'dslb-subTitle' }, t('outbound')),
            h('span', { className: 'dslb-subHint' }, t('outboundHint'))),
          data.outbound.length === 0
            ? h(Empty, { title: t('noOutbound'), next: t('noOutboundNext') })
            : h('div', { className: 'dslb-list' }, data.outbound.map((peer) => h(OutboundRow, {
              key: peer.name,
              peer,
              t,
            })))),
        h(Pairing, { t, reload }))
    }

    /** Where a discovered machine answers: address first, then host. */
    function placeLabel(peer) {
      const host = peer.address === '' ? peer.host : peer.address
      if (host === '') return ''
      return peer.port === '' ? host : `${host}:${peer.port}`
    }

    /**
     * 5. Neighbours heard over mDNS. Read-only on purpose: a discovered machine
     * is not trusted yet, so the only way to act on one is to pair it by hand.
     */
    function Discovery(props) {
      const { data, t } = props
      const discovery = data.discovery
      let body = null
      if (discovery.known === false || discovery.enabled === false) {
        body = h(Empty, { title: t('noDiscoveryOff'), next: t('noDiscoveryNext') })
      } else if (discovery.found.length === 0) {
        body = h(Empty, { title: t('noDiscovery'), next: t('noDiscoveryNext') })
      } else {
        body = h('div', { className: 'dslb-list' }, discovery.found.map((peer, index) => h('div', {
          key: `${peer.name}:${placeLabel(peer)}:${index}`,
          className: 'dslb-row',
          'data-quiet': '1',
        },
        h('div', { className: 'dslb-main' },
          h('div', { className: 'dslb-title' },
            h('span', { className: 'dslb-name' }, peer.name === '' ? t('empty') : peer.name)),
          h('div', { className: 'dslb-desc' },
            h('span', { className: 'dslb-mono' }, placeLabel(peer)))),
        peer.version === ''
          ? null
          : h('div', { className: 'dslb-side' },
            h('span', { className: 'dslb-chip' }, `v${peer.version}`)))))
      }
      return h(Card, {
        title: t('settingsDiscovery'),
        hint: discovery.error === '' ? t('discoveryFoundHint') : '',
      },
      h(React.Fragment, null,
        body,
        discovery.error === ''
          ? null
          : h('p', { className: 'dslb-warn', role: 'note' },
            t('discoveryError', { message: discovery.error }))))
    }

    /** The registered section: the panel, contained by its render boundary. */
    function LanBridgeSection(props) {
      const t = translator(props)
      return h(PanelBoundary, { t }, h(LanBridgePanel, props))
    }

    /** Top alert: the last failed read, with the last good reading still shown. */
    function ErrorBar(props) {
      const { message, t, onRetry } = props
      if (message === '') return null
      return h('div', { className: 'dslb-alert', role: 'alert' },
        h('span', null, `${t('loadFailed')}: ${message}`),
        h('button', { type: 'button', className: 'dslb-btn', onClick: onRetry }, t('retry')))
    }

    /**
     * The Settings section. Owns the poll, the optimistic sharing overrides and
     * everything transient; renders defensively so a bad payload cannot take
     * down the Settings surface.
     */
    function LanBridgePanel(props) {
      const t = translator(props)
      const { state, reload, rootRef, applyState } = useBridgeState()
      const data = state.data
      const [overrides, setOverrides] = React.useState({})
      const [pending, setPending] = React.useState({})
      const [failures, setFailures] = React.useState({})
      // Workspace-level sharing: same optimistic shape, keyed by workspaceId.
      const [wsOverrides, setWsOverrides] = React.useState({})
      const [wsPending, setWsPending] = React.useState({})
      const [wsFailures, setWsFailures] = React.useState({})
      // Which groups are open. Everything starts collapsed: the operator asked
      // for a hierarchy, not for a wall of switches.
      const [openGroups, setOpenGroups] = React.useState({})

      const toggle = React.useCallback((session, next) => {
        const id = session.sessionId
        setOverrides((previous) => ({ ...previous, [id]: next }))
        setPending((previous) => ({ ...previous, [id]: true }))
        setFailures((previous) => ({ ...previous, [id]: '' }))
        void mutate(ROUTE.share, { sessionId: id, shared: next })
          .then(() => reload())
          .catch((error) => {
            // Revert to the Host's truth, named in the row.
            setOverrides((previous) => {
              const next = { ...previous }
              delete next[id]
              return next
            })
            setFailures((previous) => ({ ...previous, [id]: `${t('shareFailed')}: ${describe(error)}` }))
          })
          .finally(() => {
            setPending((previous) => {
              const next = { ...previous }
              delete next[id]
              return next
            })
          })
      }, [reload, t])

      const toggleWorkspace = React.useCallback((group, next) => {
        const id = group.workspaceId
        setWsOverrides((previous) => ({ ...previous, [id]: next }))
        setWsPending((previous) => ({ ...previous, [id]: true }))
        setWsFailures((previous) => ({ ...previous, [id]: '' }))
        void mutate(ROUTE.shareWorkspace, { workspaceId: id, shared: next })
          .then(() => reload())
          .then(() => {
            // The fresh read is authoritative, so the optimistic value is
            // dropped as soon as the Host's own answer is on screen: the
            // workspace rule also changes every session's effective value, and
            // re-deriving that locally would only invent a second truth.
            setWsOverrides((previous) => {
              const copy = { ...previous }
              delete copy[id]
              return copy
            })
          })
          .catch((error) => {
            setWsOverrides((previous) => {
              const copy = { ...previous }
              delete copy[id]
              return copy
            })
            setWsFailures((previous) => ({ ...previous, [id]: `${t('wsShareFailed')}: ${describe(error)}` }))
          })
          .finally(() => {
            setWsPending((previous) => {
              const copy = { ...previous }
              delete copy[id]
              return copy
            })
          })
      }, [reload, t])

      const toggleOpen = React.useCallback((id) => {
        setOpenGroups((previous) => ({ ...previous, [id]: previous[id] !== true }))
      }, [])

      const toggleAll = React.useCallback((next) => {
        const groups = data === null || data.workspaces === null ? [] : data.workspaces
        const map = {}
        for (const group of groups) map[group.workspaceId] = next
        setOpenGroups(map)
      }, [data])

      // The page head names the surface; the cards below do the talking.
      const header = h(React.Fragment, null,
        h('style', { key: 'dslb-style' }, CSS),
        h('div', { className: 'dslb-pageHead', key: 'dslb-head' },
          h('h2', { className: 'dslb-pageTitle' }, t('title')),
          h('p', { className: 'dslb-pageSub' }, t('subtitle'))))

      if (data === null) {
        if (state.phase === 'error') {
          return h('div', { className: 'dslb-root', ref: rootRef },
            header,
            h('div', { className: 'dslb-alert', role: 'alert' },
              h('span', null, `${t('loadFailed')}: ${state.error}`),
              h('button', { type: 'button', className: 'dslb-btn', onClick: () => reload() }, t('retry'))))
        }
        return h('div', { className: 'dslb-root', ref: rootRef },
          header,
          h('div', { className: 'dslb-loading' }, t('loading')))
      }

      // Order is the operator's question order: what is this machine doing,
      // how do I change it, who can reach it, which Sessions are exposed, who
      // is out there.
      return h('div', { className: 'dslb-root', ref: rootRef },
        header,
        h(ErrorBar, { message: state.error, t, onRetry: () => reload() }),
        h(StatusHero, { data, t }),
        h(ListenSettings, { data, t, applyState }),
        h(Peers, { data, t, reload }),
        h(Sessions, {
          data,
          t,
          overrides,
          pending,
          failures,
          wsOverrides,
          wsPending,
          wsFailures,
          openGroups,
          onToggle: toggle,
          onToggleWorkspace: toggleWorkspace,
          onToggleOpen: toggleOpen,
          onToggleAll: toggleAll,
        }),
        h(Discovery, { data, t }))
    }

    /**
     * Render containment: a defect inside one row must leave the rest of the
     * Settings surface usable instead of unmounting the section.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        // Nothing to report to: the panel only has this one seat.
        void error
      }

      render() {
        if (this.state.failed) {
          return h('div', { className: 'dslb-root' },
            h('style', null, CSS),
            h('div', { className: 'dslb-alert', role: 'alert' }, this.props.t('loadFailed')))
        }
        return this.props.children
      }
    }

    /** Settings nav glyph: two nodes joined by one link. */
    function SectionIcon(props) {
      const size = typeof props.size === 'number' && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': 'true',
        focusable: 'false',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('circle', { cx: 5.5, cy: 18, r: 3 }),
      h('circle', { cx: 18.5, cy: 6, r: 3 }),
      h('path', { d: 'M8.2 16.1 15.8 7.9' }),
      h('path', { d: 'M12 12.5c2.2 0 3.6-.6 4.6-1.9' }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          ctx.effect(() => locale.register(NS, 'zh', DICT.zh), 'lan-bridge: zh dictionary')
          ctx.effect(() => locale.register(NS, 'en', DICT.en), 'lan-bridge: en dictionary')
        }
        const t = typeof locale?.bind === 'function' ? locale.bind(NS) : (key) => (DICT.zh[key] !== undefined ? DICT.zh[key] : key)

        // One Settings page: the shared decision surface keeps a per-Session
        // seat (the right sidebar tab type) out of it, so the same switches
        // never multiply per Session, and it costs the frame no permanent
        // height the way a shell.bottom strip would.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 25,
          label: () => t('nav'),
          locale: NS,
        }, LanBridgeSection))

        // The nav row's glyph, matched by the same id.
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: SECTION_ID,
          locale: NS,
        }, SectionIcon))
      },
    }
  },
})
