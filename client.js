/**
 * Browser half of the LAN bridge panel: one Settings section
 * (`settings.section`) that renders the bridge as a page of cards. The page
 * refreshes itself every 3 s while it is on screen (and on window focus), and
 * nothing inside it trusts a payload: a Host older than the panel, a missing
 * key or a malformed list degrades to an empty or partial card, never to a
 * thrown render.
 *
 * Layout (top to bottom), each block one `.dslb-card` of the same column:
 *   1. `StatusHero`    — name, role pill, listener state line, copyable address,
 *                        and the optional build line (`Host 0.4.4`, a warn pill
 *                        when the code on disk is newer, a quiet pill when the
 *                        page itself came from another build). Every version
 *                        field is optional; no block, no line.
 *   2. `ListenSettings`— the listener itself: name, bind address/port, plaintext
 *                        consent, mDNS switch, trusted hosts, TLS pair, sticky
 *                        save bar. Saving POSTs the whole settings set and
 *                        replaces the panel state with the state the answer
 *                        carries, so a clamped port or a failed rebind shows up
 *                        in the same paint. No optimistic write, no re-read.
 *   3. `Peers`         — inbound / outbound sub-cards plus `Pairing` (a one-time
 *                        token, shown once, never persisted here). An outbound
 *                        row edits in place (address prefilled, the token field
 *                        always starts blank — blank means "keep the stored
 *                        one") and can probe the peer; the two-way mirror
 *                        handshake lives here too: a pending request from
 *                        another machine is a grant in both directions, so it
 *                        is listed with its consequence and 接受 / 拒绝, and a
 *                        request this machine sent shows as a waiting line
 *                        under its peer. A Host without a `mirrors` key renders
 *                        none of it, and none of it is an error. Removing an
 *                        outbound peer asks twice and the question expires by
 *                        itself; inbound peers are revoked (their token), which
 *                        is a different thing and keeps its own control.
 *                        The token field on the pair form is the only place a
 *                        secret is ever displayed, and only until dismissed.
 *   4. `Sessions`      — the panel's main decision surface: one collapsible row
 *                        per workspace (`WorkspaceGroup`, closed by default, a
 *                        switch that shares the whole workspace) over indented
 *                        per-session switches. Both levels are optimistic and
 *                        revert on refusal. A workspace rule makes the sessions
 *                        under it effectively shared, so their own switches
 *                        render checked and disabled instead of lying about it.
 *                        A Host that sends no `workspaces` key keeps the old
 *                        flat list.
 *   5. `FilesSettings` — the peer-visible file roots: one switch, the per-file
 *                        cap (typed in MiB, stored in bytes) and a root editor
 *                        (name / local path / writable). Shares the sticky save
 *                        bar with `ListenSettings`; a Host without a `files`
 *                        block shows the off state.
 *   6. `Discovery`     — mDNS neighbours heard on the LAN (read-only)
 *   7. `Audit`         — the newest cross-machine calls (time, source peer,
 *                        method, path, outcome), five at a time with an
 *                        expand/collapse link. Hidden entirely when the Host
 *                        sends no readable log.
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

    /**
     * The panel build, kept in step with the released bundle. Compared with
     * `state.version.running` only to warn that the page in front of you was
     * loaded from an older bundle than the Host is serving.
     */
    const PANEL_VERSION = '0.4.4'

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
        capFiles: '文件传输',
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
        filesTitle: '文件传输',
        filesHint: '对端可以在你勾选为可写的根目录里读写文件；路径只在本机生效，不会发给对端。',
        filesPostureOn: '已开启',
        filesPostureOff: '已关闭',
        filesRootsCount: '{count} 个根目录',
        filesLimit: '单文件上限 {mib} MiB',
        filesEnabled: '允许对端传输文件',
        filesEnabledHint: '关闭后对端的文件能力立即失效，已签发的令牌仍然保留。',
        filesMax: '单文件上限（MiB）',
        filesMaxHint: '按 MiB 填写，保存时换算成字节；Host 只接受整数。',
        filesRoots: '根目录',
        filesRootsHint: '每个根目录给对端一个名字；可写表示允许写入，否则只读。',
        filesRootName: '名称',
        filesRootPath: '路径',
        filesRootWritable: '可写',
        filesRootWritableHint: '允许写入此根目录',
        filesRootRemove: '删除',
        filesRootAdd: '新增根目录',
        filesNoRoots: '还没有根目录：对端看不到任何可读写的目录',
        filesRootNameInvalid: '名称只能是 32 个字符以内的小写字母、数字、下划线或短横线，且以字母或数字开头。',
        filesRootNameDuplicate: '根目录名称必须唯一。',
        filesRootPathMissing: '路径不能为空。',
        filesMaxInvalid: '单文件上限必须是 1 到 4096 之间的整数 MiB。',
        versionHost: 'Host {version}',
        versionDisk: '磁盘 {version} · 重启后生效',
        versionPanel: '面板 {version}',
        versionPanelHint: '面板比 Host 新或旧，⌘R 刷新页面即可。',
        auditTitle: '审计',
        auditHint: '每一次跨机调用都记在这里；文件与路径只写在本机。',
        auditEmpty: '还没有跨机调用',
        auditExpand: '展开全部 {count} 条',
        auditCollapse: '收起',
        peerEdit: '编辑',
        peerCheck: '测试连接',
        peerSave: '保存对等端',
        peerCancel: '取消',
        peerName: '名称',
        peerUrl: '地址',
        peerToken: '令牌',
        peerTokenKeep: '留空则保持原令牌',
        peerUrlHint: '必须是 http:// 或 https:// 地址。',
        peerAdd: '添加对等端',
        peerCheckOk: '可达 as "{name}"',
        peerCheckFailed: '不可达：{error}',
        peerAddSaved: '已保存对等端。',
        peerRemove: '移除',
        peerRemoveConfirm: '确认移除',
        peerRemoveHint: '移除后本机不再持有对方的令牌；对方仍然持有本机令牌，需要的话可以在对方面板里撤销。',
        peerRemoveFailed: '移除失败',
        peerRemoved: '已移除对等端。',
        peerAddUnreachable: '已保存，但对方暂时没应答。',
        peerAddFailed: '添加失败',
        peerSaveFailed: '保存失败',
        peerUrlInvalid: '地址必须以 http:// 或 https:// 开头。',
        peerNameMissing: '请填写名称。',
        peerTokenMissing: '添加对等端时必须填写令牌。',
        mirrorIncoming: '{name} 请求与这台机器双向配对',
        mirrorConsequence: '接受后，对方可以调用本机，本机也用同一套权限调用对方。',
        mirrorAccept: '接受',
        mirrorReject: '拒绝',
        mirrorForget: '忽略',
        mirrorRetry: '重试',
        mirrorWaiting: '已请求双向配对，等待对方在它面板里接受',
        mirrorUndelivered: '已接受，但对方暂时没收到，可稍后重试',
        mirrorFailed: '配对请求失败：{message}',
        settingsAutoMirror: '自动接受反向配对',
        settingsAutoMirrorHint: '打开后，任何能连上本机的对等端都可以自助完成双向配对，不需要你点确认。',
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
        capFiles: 'files',
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
        filesTitle: 'File transfer',
        filesHint: 'Peers can read and write inside the roots you mark writable; local paths never leave this machine.',
        filesPostureOn: 'On',
        filesPostureOff: 'Off',
        filesRootsCount: '{count} roots',
        filesLimit: 'max {mib} MiB per file',
        filesEnabled: 'Allow peers to transfer files',
        filesEnabledHint: 'Turning this off drops the file capability immediately; issued tokens stay.',
        filesMax: 'Max file size (MiB)',
        filesMaxHint: 'Entered in MiB and converted to bytes on save; the Host accepts integers only.',
        filesRoots: 'Roots',
        filesRootsHint: 'Each root gives peers a name; writable allows writes, otherwise it is read-only.',
        filesRootName: 'Name',
        filesRootPath: 'Path',
        filesRootWritable: 'Writable',
        filesRootWritableHint: 'Allow writes in this root',
        filesRootRemove: 'Remove',
        filesRootAdd: 'Add a root',
        filesNoRoots: 'No roots yet: peers cannot see any readable or writable directory',
        filesRootNameInvalid: 'A name is up to 32 lowercase letters, digits, underscores or dashes, starting with a letter or digit.',
        filesRootNameDuplicate: 'Root names must be unique.',
        filesRootPathMissing: 'The path cannot be empty.',
        filesMaxInvalid: 'Max file size must be an integer between 1 and 4096 MiB.',
        versionHost: 'Host {version}',
        versionDisk: 'Disk {version} · applies after restart',
        versionPanel: 'Panel {version}',
        versionPanelHint: 'This panel is older or newer than the Host; ⌘R reloads the page.',
        auditTitle: 'Audit',
        auditHint: 'Every cross-machine call lands here; files and paths are written on this machine only.',
        auditEmpty: 'No cross-machine calls yet',
        auditExpand: 'Show all {count}',
        auditCollapse: 'Collapse',
        peerEdit: 'Edit',
        peerCheck: 'Test connection',
        peerSave: 'Save peer',
        peerCancel: 'Cancel',
        peerName: 'Name',
        peerUrl: 'Address',
        peerToken: 'Token',
        peerTokenKeep: 'Leave empty to keep the current token',
        peerUrlHint: 'Must be an http:// or https:// address.',
        peerAdd: 'Add a peer',
        peerCheckOk: 'reachable as "{name}"',
        peerCheckFailed: 'unreachable: {error}',
        peerAddSaved: 'Peer saved.',
        peerRemove: 'Remove',
        peerRemoveConfirm: 'Confirm removal',
        peerRemoveHint: 'This machine forgets the other side token. The other side still holds a token for this machine; revoke it there if needed.',
        peerRemoveFailed: 'Remove failed',
        peerRemoved: 'Peer removed.',
        peerAddUnreachable: 'Saved, but the peer did not answer yet.',
        peerAddFailed: 'Add failed',
        peerSaveFailed: 'Save failed',
        peerUrlInvalid: 'The address must start with http:// or https://.',
        peerNameMissing: 'Enter a name.',
        peerTokenMissing: 'Adding a peer needs its token.',
        mirrorIncoming: '{name} asks for two-way pairing with this machine',
        mirrorConsequence: 'Accepting lets that machine call this one, and this one calls it back with the same permissions.',
        mirrorAccept: 'Accept',
        mirrorReject: 'Reject',
        mirrorForget: 'Dismiss',
        mirrorRetry: 'Retry',
        mirrorWaiting: 'Two-way pairing requested; waiting for the other machine to accept it in its own panel',
        mirrorUndelivered: 'Accepted, but the other machine has not received it yet; retry later',
        mirrorFailed: 'Pairing request failed: {message}',
        settingsAutoMirror: 'Accept reverse pairing automatically',
        settingsAutoMirrorHint: 'When on, any peer that can reach this machine can complete two-way pairing on its own, without you confirming anything.',
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
      peer: 'api/lan-bridge.peer',
      mirror: 'api/lan-bridge.mirror',
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
      '.dslb-statusLine{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;font-size:12px;line-height:18px;',
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
      // Indented by the dot plus its gap so a wrapped version strip still reads
      // as part of the same status block instead of starting at the card edge.
      '.dslb-lineMeta{display:flex;align-items:center;gap:6px;min-width:0;flex:none;flex-wrap:wrap;',
      'padding-left:14px}',
      '.dslb-version{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);',
      'white-space:nowrap}',
      '.dslb-pill[data-tone="warn"]{background:var(--dsw-alias-state-warn-tertiary,#fef3c7);',
      'border-color:transparent;color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.dslb-pill[data-tone="quiet"]{color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dslb-auditRow{display:grid;grid-template-columns:auto minmax(0,auto) minmax(0,1.1fr) minmax(0,1.4fr) auto;',
      'gap:2px 10px;align-items:baseline;min-width:0;padding:8px 0;font-size:12px;line-height:18px}',
      '.dslb-auditRow+.dslb-auditRow{border-top:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
      '.dslb-auditTime{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'color:var(--dsw-alias-label-secondary,#5b6270);white-space:nowrap}',
      '.dslb-auditPeer,.dslb-auditMethod,.dslb-auditPath{min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap}',
      '.dslb-auditPeer{color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dslb-auditMethod{color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-auditPath{color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dslb-auditOutcome{white-space:nowrap;color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-auditOutcome[data-tone="success"]{color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dslb-auditOutcome[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#ec1313)}',
      '.dslb-cardPosture{margin:0;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-secondary,#5b6270);overflow-wrap:anywhere}',
      '.dslb-roots{display:flex;flex-direction:column;min-width:0}',
      '.dslb-rootRow{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,2fr) auto auto;',
      'gap:0 12px;align-items:start;min-width:0;padding:12px 0}',
      '.dslb-rootRow+.dslb-rootRow{border-top:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}',
      '.dslb-rootField{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dslb-rootError{min-height:18px;margin:2px 0 0}',
      '.dslb-rootWritable{display:flex;flex-direction:column;gap:4px;align-items:flex-start;min-width:0}',
      '.dslb-rootWritable .dslb-switch{margin-top:6px}',
      '.dslb-rootActions{display:flex;align-items:flex-start;min-width:0;padding-top:22px}',
      '.dslb-rootFoot{display:flex;align-items:center;justify-content:flex-start;gap:12px;flex-wrap:wrap}',
      // Peers: the inline editor, the probe answer and the mirror handshake.
      '.dslb-peerForm{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.dslb-peerFormGrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px;min-width:0}',
      '.dslb-peerFormSingle{display:grid;grid-template-columns:minmax(0,1fr);gap:8px 12px;min-width:0}',
      '.dslb-peerFormActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}',
      '.dslb-peerState{display:flex;align-items:center;gap:8px;flex:none}',
      '.dslb-peerActions{flex-wrap:wrap;justify-content:flex-end;row-gap:6px}',
      '.dslb-peerCheck{margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere;',
      'color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dslb-peerCheck[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dslb-peerCheck[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#ec1313)}',
      '.dslb-peerWait{margin:0;overflow-wrap:anywhere}',
      '.dslb-peerWait[data-tone="warn"]{',
      'color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b45309))}',
      '.dslb-row[data-wrap="1"]{align-items:flex-start;flex-wrap:wrap;row-gap:8px}',
      '.dslb-mirrors{display:flex;flex-direction:column;gap:6px;min-width:0;margin-bottom:4px}',
      '.dslb-mirrorRow{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;',
      'box-sizing:border-box;min-width:0;padding:10px;',
      'border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:var(--dsw-radius-lg,8px)}',
      '.dslb-formError{margin:2px 0 0;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-state-error-primary,#ec1313)}',
      '.dslb-inputMono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
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
      const files = record(settings.files)
      const fileRoots = list(files === null ? null : files.roots).map((entry) => {
        const fileRoot = record(entry)
        if (fileRoot === null) return null
        const fileRootName = text(fileRoot.name, '')
        if (fileRootName === '') return null
        return {
          name: fileRootName,
          path: text(fileRoot.path, ''),
          writable: fileRoot.writable === true,
        }
      }).filter((fileRoot) => fileRoot !== null)
      return {
        name: text(settings.name, text(record(root).name, '')),
        host: text(settings.host, text(listen.host, '')),
        port,
        insecureHttp: settings.insecureHttp === true,
        allowPeersToCreateSessions: settings.allowPeersToCreateSessions !== false,
        trustedHosts: list(settings.trustedHosts).map((value) => text(value, '')).filter((value) => value !== ''),
        tls: tls === null ? null : { certFile: text(tls.certFile, ''), keyFile: text(tls.keyFile, '') },
        discovery: settings.discovery === true,
        // Absent on a Host older than 0.5.0: off. Turning it on widens what any
        // reachable peer can do, so the quiet default is the safe one.
        autoAcceptMirror: settings.autoAcceptMirror === true,
        // Absent on an older Host: off, no roots, and the documented 256 MiB
        // default. That is a quiet state, never an error; a save fills it in.
        files: {
          enabled: files !== null && files.enabled === true,
          maxFileBytes: files !== null && typeof files.maxFileBytes === 'number' && Number.isFinite(files.maxFileBytes)
            ? files.maxFileBytes
            : 0,
          chunkBytes: files !== null && typeof files.chunkBytes === 'number' && Number.isFinite(files.chunkBytes)
            ? files.chunkBytes
            : 0,
          stagingTtlMs: files !== null && typeof files.stagingTtlMs === 'number' && Number.isFinite(files.stagingTtlMs)
            ? files.stagingTtlMs
            : 0,
          roots: fileRoots,
        },
      }
    }

    /** What the form shows before the first read: the Host defaults. */
    const EMPTY_SETTINGS = {
      name: '',
      host: '',
      port: null,
      insecureHttp: false,
      allowPeersToCreateSessions: true,
      trustedHosts: [],
      tls: null,
      discovery: false,
      autoAcceptMirror: false,
      files: { enabled: false, maxFileBytes: 0, chunkBytes: 0, stagingTtlMs: 0, roots: [] },
    }

    /** One root name rule, mirrored from the Host: 1-32 of [a-z0-9_-]. */
    const FILE_ROOT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i

    /** MiB as the form shows it, from the bytes the Host stores. */
    function mibFromBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '256'
      const mib = bytes / 1048576
      return String(Math.round(mib * 100) / 100)
    }

    /** The operator payload for the files block: MiB back to bytes. */
    function filesPayload(files) {
      const mib = Number(files.maxMiB)
      return {
        enabled: files.enabled === true,
        maxFileBytes: Number.isFinite(mib) ? Math.round(mib * 1048576) : 0,
        roots: files.roots.map((root) => ({
          name: root.name.trim(),
          path: root.path.trim(),
          writable: root.writable === true,
        })),
      }
    }

    function sameFiles(left, right) {
      if (left.enabled !== right.enabled) return false
      if (left.maxMiB !== right.maxMiB) return false
      if (left.roots.length !== right.roots.length) return false
      for (let index = 0; index < left.roots.length; index += 1) {
        const a = left.roots[index]
        const b = right.roots[index]
        if (a.name !== b.name || a.path !== b.path || a.writable !== b.writable) return false
      }
      return true
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
        // All three are optional: an older Host simply has no version block and
        // the hero renders no version text rather than throwing.
        version: (() => {
          const block = record(root.version)
          if (block === null) return { running: '', disk: '', drift: false }
          return {
            running: text(block.running, ''),
            disk: text(block.disk, ''),
            drift: block.drift === true,
          }
        })(),
        // Absent or malformed audit data hides the card; it is never an error.
        audit: (() => {
          if (!Array.isArray(root.audit)) return null
          const rows = []
          for (const entry of root.audit) {
            const item = record(entry)
            if (item === null) continue
            const method = text(item.method, '')
            if (method === '') continue
            rows.push({
              t: text(item.t, ''),
              peer: text(item.peer, ''),
              method,
              path: text(item.path, ''),
              outcome: text(item.outcome, ''),
              code: text(item.code, ''),
            })
          }
          // A log we cannot read at all is treated like no log: the card stays
          // out of the page instead of claiming nothing has happened.
          if (rows.length === 0 && root.audit.length > 0) return null
          return rows.slice(-20)
        })(),
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
        // Mirrors are the two-way pairing requests: `in` asks this machine,
        // `out` asks another one. `null` means the Host predates 0.5.0, and the
        // whole mirror layer stays off the page instead of pretending to be empty.
        mirrors: (() => {
          const block = record(root.mirrors)
          if (block === null) return null
          const project = (entry) => {
            const item = record(entry)
            if (item === null) return null
            const name = text(item.name, '')
            if (name === '') return null
            return {
              name,
              url: text(item.url, ''),
              capabilities: list(item.capabilities).map((value) => text(value, '')).filter((value) => value !== ''),
              state: text(item.state, ''),
              at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : null,
              token: text(item.token, ''),
              error: text(item.error, ''),
            }
          }
          return {
            in: list(block.in).map(project).filter((item) => item !== null),
            out: list(block.out).map(project).filter((item) => item !== null),
          }
        })(),
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
      if (capability === 'files') return t('capFiles')
      return capability
    }

    /**
     * Capabilities a token can carry, in the order the pair form offers them.
     * Mirrors CAPABILITIES in lib/config.js; the Host stays the authority and
     * drops names it does not know.
     */
    const PAIR_CAPABILITIES = ['read', 'prompt', 'control', 'create', 'archive', 'collab', 'approve', 'files']

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
        autoAcceptMirror: settings.autoAcceptMirror === true,
        files: {
          enabled: settings.files.enabled === true,
          maxMiB: mibFromBytes(settings.files.maxFileBytes),
          roots: settings.files.roots.map((root) => ({
            name: root.name,
            path: root.path,
            writable: root.writable === true,
          })),
        },
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
        && left.autoAcceptMirror === right.autoAcceptMirror
        && sameFiles(left.files, right.files)
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
        settings.autoAcceptMirror === true ? '1' : '0',
        settings.files.enabled ? '1' : '0',
        String(settings.files.maxFileBytes),
        settings.files.roots
          .map((root) => `${root.name}\u0001${root.path}\u0001${root.writable ? '1' : '0'}`)
          .join('\u0001'),
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
              h('span', { className: 'dslb-statusText', title: line }, line),
              // The version strip is optional end to end: no running version,
              // no strip; a disk version that differs from the running one adds
              // a warn pill saying a restart is what applies it.
              data.version.running === ''
                ? null
                : h('span', { className: 'dslb-lineMeta' },
                  h('span', { className: 'dslb-version' }, t('versionHost', { version: data.version.running })),
                  data.version.drift === true && data.version.disk !== ''
                    ? h('span', {
                      className: 'dslb-pill',
                      'data-tone': 'warn',
                      title: t('versionDisk', { version: data.version.disk }),
                    }, t('versionDisk', { version: data.version.disk }))
                    : null,
                  data.version.running !== PANEL_VERSION
                    ? h('span', {
                      className: 'dslb-pill',
                      'data-tone': 'quiet',
                      title: t('versionPanelHint'),
                    }, t('versionPanel', { version: PANEL_VERSION }))
                    : null))),
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
    /**
     * One form state for the whole settings page: the listener and the files
     * blocks are saved by the same POST, so they must share one draft, one
     * dirty flag and one save bar.
     */
    function useSettingsForm(props) {
      const { data, t, applyState } = props
      const settings = data === null ? EMPTY_SETTINGS : data.settings
      const listen = data === null ? { listening: false, port: null, host: '' } : data.listen
      const addresses = data === null ? [] : data.addresses
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

      const updateFiles = (patch) => {
        setFailure(null)
        setSaved(false)
        setDraft((previous) => ({ ...previous, files: { ...previous.files, ...patch } }))
      }

      const updateRoot = (index, patch) => {
        setFailure(null)
        setSaved(false)
        setDraft((previous) => ({
          ...previous,
          files: {
            ...previous.files,
            roots: previous.files.roots.map((root, at) => (at === index ? { ...root, ...patch } : root)),
          },
        }))
      }

      const addRoot = () => {
        setFailure(null)
        setSaved(false)
        setDraft((previous) => ({
          ...previous,
          files: {
            ...previous.files,
            roots: previous.files.roots.concat([{ name: '', path: '', writable: false }]),
          },
        }))
      }

      const removeRoot = (index) => {
        setFailure(null)
        setSaved(false)
        setDraft((previous) => ({
          ...previous,
          files: {
            ...previous.files,
            roots: previous.files.roots.filter((root, at) => at !== index),
          },
        }))
      }

      // Files validation is advisory only: the server is the source of truth
      // and its sentence is what reaches the operator, so these never disable
      // the save button — they just sit under the field they explain.
      const fileRootErrors = (() => {
        const seen = {}
        return draft.files.roots.map((root) => {
          const rootName = root.name.trim()
          const key = rootName.toLowerCase()
          let nameError = ''
          if (rootName !== '' && !FILE_ROOT_NAME.test(rootName)) nameError = 'filesRootNameInvalid'
          else if (rootName !== '' && seen[key] === true) nameError = 'filesRootNameDuplicate'
          if (rootName !== '') seen[key] = true
          // A freshly added, still-empty row is not a mistake yet — it is a row
          // waiting for input. Complaining here just puts a red line under an
          // empty field the moment you click "add".
          const touched = rootName !== '' || root.path.trim() !== ''
          return {
            name: touched ? nameError : '',
            path: root.path.trim() === '' && touched ? 'filesRootPathMissing' : '',
          }
        })
      })()
      const filesMaxText = draft.files.maxMiB.trim()
      const filesMaxNumber = /^\d+$/.test(filesMaxText) ? Number(filesMaxText) : NaN
      const filesMaxValid = Number.isInteger(filesMaxNumber) && filesMaxNumber >= 1 && filesMaxNumber <= 4096
      const filesOpen = draft.files.enabled === true

      const save = () => {
        if (saving || problem !== '' || !dirty) return
        const payload = {
          name,
          host,
          port: portNumber,
          insecureHttp: draft.insecureHttp,
          discovery: draft.discovery,
          autoAcceptMirror: draft.autoAcceptMirror,
          allowPeersToCreateSessions: draft.allowPeersToCreateSessions,
          trustedHosts: parseTrustedHosts(draft.trustedHosts),
          tls: tlsPresent ? { certFile, keyFile } : null,
          files: filesPayload(draft.files),
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
      for (const candidate of ['127.0.0.1', '0.0.0.0'].concat(addresses)) {
        if (candidate === '' || hostChoices.indexOf(candidate) !== -1) continue
        hostChoices.push(candidate)
      }
      const assigned = listen.listening === true ? listen.port : ''
      const showAssigned = settings.port === 0 && assigned !== ''
      const assignedDraft = draft.port.trim() === '0' && assigned !== ''


      return {
        settings,
        draft,
        saving,
        failure,
        saved,
        update,
        updateFiles,
        updateRoot,
        addRoot,
        removeRoot,
        name,
        host,
        portText,
        portNumber,
        portValid,
        certFile,
        keyFile,
        tlsHalf,
        tlsPresent,
        hostMissing,
        outward,
        insecureWarn,
        nameMissing,
        nameTooLong,
        problem,
        dirty,
        listenChanged,
        nameLiveChanged,
        canSave,
        hostChoices,
        assigned,
        showAssigned,
        assignedDraft,
        fileRootErrors,
        filesMaxValid,
        filesMaxNumber,
        filesOpen,
        clearFailure: () => setFailure(null),
        save,
      }
    }

    function ListenSettings(props) {
      const { data, t } = props
      const form = props.form
      const settings = form.settings
      const draft = form.draft
      const saving = form.saving
      const failure = form.failure
      const saved = form.saved
      const update = form.update
      const name = form.name
      const host = form.host
      const portText = form.portText
      const portNumber = form.portNumber
      const portValid = form.portValid
      const certFile = form.certFile
      const keyFile = form.keyFile
      const tlsHalf = form.tlsHalf
      const tlsPresent = form.tlsPresent
      const hostMissing = form.hostMissing
      const outward = form.outward
      const insecureWarn = form.insecureWarn
      const nameMissing = form.nameMissing
      const nameTooLong = form.nameTooLong
      const problem = form.problem
      const dirty = form.dirty
      const listenChanged = form.listenChanged
      const nameLiveChanged = form.nameLiveChanged
      const canSave = form.canSave
      const hostChoices = form.hostChoices
      const assigned = form.assigned
      const showAssigned = form.showAssigned
      const assignedDraft = form.assignedDraft
      const save = form.save
      const clearFailure = form.clearFailure

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
            })),
          // Auto-accept widens trust, so the risk sentence sits under the
          // switch itself instead of hiding in a tooltip.
          h('div', { className: 'dslb-toggleRow' },
            h('div', { className: 'dslb-main' },
              h('div', { className: 'dslb-title' }, t('settingsAutoMirror')),
              h('div', { className: 'dslb-desc' }, t('settingsAutoMirrorHint'))),
            h(Switch, {
              checked: draft.autoAcceptMirror,
              label: t('settingsAutoMirror'),
              disabled: saving,
              onChange: () => update('autoAcceptMirror', !draft.autoAcceptMirror),
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
              onClick: clearFailure,
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

    /** HH:MM:SS in the viewer's own timezone; the raw string if unparsable. */
    function auditTime(value) {
      const date = new Date(value)
      if (!Number.isFinite(date.getTime())) return value
      const pad = (part) => String(part).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Keep the file name visible when a path is too long for one column. */
    function shortPath(value, limit) {
      if (value.length <= limit) return value
      const cut = value.lastIndexOf('/')
      const tail = cut === -1 ? value.slice(value.length - (limit - 1)) : value.slice(cut)
      const head = value.slice(0, Math.max(0, limit - tail.length - 1))
      return `${head}…${tail}`
    }

    /** One audit line: time, source peer, method, path (if any) and outcome. */
    function Audit(props) {
      const { data, t } = props
      const [open, setOpen] = React.useState(false)
      if (data.audit === null) return null
      // The Host stores oldest first; the newest line is the one operators want.
      const entries = data.audit.slice().reverse()
      const shown = open ? entries : entries.slice(0, 5)
      return h(Card, {
        title: t('auditTitle'),
        hint: t('auditHint'),
        actions: entries.length <= 5
          ? null
          : h('button', {
            type: 'button',
            className: 'dslb-linkBtn',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen(!open),
          }, open ? t('auditCollapse') : t('auditExpand', { count: entries.length })),
      },
      entries.length === 0
        ? h(Empty, { title: t('auditEmpty'), next: null })
        : h('div', { className: 'dslb-list' }, shown.map((entry, index) => {
          const failed = entry.code.indexOf('bridge/') === 0
          const tone = failed ? 'error' : (entry.outcome === 'ok' ? 'success' : 'quiet')
          // A refusal often reports the same string as both outcome and code;
          // do not print it twice.
          const result = entry.code === '' || entry.code === entry.outcome
            ? entry.outcome
            : `${entry.outcome} · ${entry.code}`
          return h('div', { className: 'dslb-auditRow', key: `audit-${index}` },
            h('span', { className: 'dslb-auditTime' }, auditTime(entry.t)),
            h('span', { className: 'dslb-auditPeer', title: entry.peer }, entry.peer === '' ? t('empty') : entry.peer),
            h('span', { className: 'dslb-auditMethod', title: entry.method }, entry.method),
            entry.path === ''
              ? h('span', { className: 'dslb-auditPath', 'aria-hidden': 'true' }, '')
              : h('span', { className: 'dslb-auditPath', title: entry.path }, shortPath(entry.path, 40)),
            h('span', { className: 'dslb-auditOutcome', 'data-tone': tone }, result))
        })))
    }

    /**
     * One root row: a peer-visible name, the local absolute path (mono, because
     * it is a path) and whether writes are allowed. The path is never sent to a
     * peer; this row is the operator view.
     */
    function FileRootRow(props) {
      const { index, root, errors, disabled, t, onUpdate, onRemove } = props
      const position = index + 1
      // Every field keeps one empty error line, whether or not it has a message:
      // otherwise the first complaint pushes its own input up and the four columns
      // stop sharing a baseline (that is exactly what looked broken).
      const errorLine = (message) => h('span', {
        className: 'dslb-formError dslb-rootError',
        role: message === '' ? undefined : 'alert',
      }, message === '' ? '' : t(message))
      return h('div', { className: 'dslb-rootRow' },
        h('label', { className: 'dslb-rootField' },
          h('span', { className: 'dslb-formLabel' }, t('filesRootName')),
          h('input', {
            className: 'dslb-input',
            value: root.name,
            spellCheck: false,
            disabled,
            'aria-label': `${t('filesRootName')} ${position}`,
            onChange: (event) => onUpdate(index, { name: event.currentTarget.value }),
          }),
          errorLine(errors.name)),
        h('label', { className: 'dslb-rootField' },
          h('span', { className: 'dslb-formLabel' }, t('filesRootPath')),
          h('input', {
            className: 'dslb-input dslb-inputMono',
            value: root.path,
            spellCheck: false,
            disabled,
            'aria-label': `${t('filesRootPath')} ${position}`,
            onChange: (event) => onUpdate(index, { path: event.currentTarget.value }),
          }),
          errorLine(errors.path)),
        h('div', { className: 'dslb-rootWritable' },
          h('span', { className: 'dslb-formLabel' }, t('filesRootWritable')),
          h(Switch, {
            checked: root.writable === true,
            label: t('filesRootWritableHint'),
            disabled,
            onChange: () => onUpdate(index, { writable: root.writable !== true }),
          })),
        h('div', { className: 'dslb-rootActions' },
          h('button', {
            type: 'button',
            className: 'dslb-btn',
            'data-tone': 'danger',
            disabled,
            'aria-label': `${t('filesRootRemove')} ${root.name === '' ? position : root.name}`,
            onClick: () => onRemove(index),
          }, t('filesRootRemove'))))
    }

    /**
     * The files card. It shares the settings draft with the listener card (one
     * POST saves both), so it carries no save bar of its own; dirty state and
     * the save button live there. Peers only ever see the root names, so the
     * posture line speaks in names, roots and the per-file cap.
     */
    function FilesSettings(props) {
      const { t, form } = props
      const files = form.draft.files
      const roots = files.roots
      const capText = files.maxMiB.trim() === '' ? '256' : files.maxMiB.trim()
      const posture = files.enabled === true
        ? [
          t('filesPostureOn'),
          t('filesRootsCount', { count: roots.length }),
          t('filesLimit', { mib: capText }),
        ].join(' · ')
        : t('filesPostureOff')

      return h('section', { className: 'dslb-card', 'aria-label': t('filesTitle') },
        h('div', { className: 'dslb-cardHead' },
          h('div', { className: 'dslb-cardHeadMain' },
            h('h3', { className: 'dslb-cardTitle' }, t('filesTitle')),
            h('p', { className: 'dslb-cardPosture' }, posture),
            h('p', { className: 'dslb-cardHint' }, t('filesHint')))),

        h('div', { className: 'dslb-list' },
          h('div', { className: 'dslb-toggleRow' },
            h('div', { className: 'dslb-main' },
              h('span', { className: 'dslb-title' }, t('filesEnabled')),
              h('span', { className: 'dslb-desc' }, t('filesEnabledHint'))),
            h('div', { className: 'dslb-side' },
              h(Switch, {
                checked: files.enabled === true,
                label: t('filesEnabled'),
                disabled: form.saving,
                onChange: () => form.updateFiles({ enabled: files.enabled !== true }),
              })))),

        h('label', { className: 'dslb-formField' },
          h('span', { className: 'dslb-formLabel' }, t('filesMax')),
          h('input', {
            className: 'dslb-input',
            value: files.maxMiB,
            inputMode: 'numeric',
            spellCheck: false,
            disabled: form.saving,
            'aria-label': t('filesMax'),
            onChange: (event) => form.updateFiles({ maxMiB: event.currentTarget.value }),
          }),
          h('span', { className: 'dslb-formHint' }, t('filesMaxHint')),
          form.filesMaxValid ? null : h('span', { className: 'dslb-formError' }, t('filesMaxInvalid'))),

        h('div', { className: 'dslb-formStack' },
          h('span', { className: 'dslb-formLabel' }, t('filesRoots')),
          h('span', { className: 'dslb-formHint' }, t('filesRootsHint')),
          roots.length === 0
            ? (files.enabled === true
              ? h('p', { className: 'dslb-warn', role: 'status' }, t('filesNoRoots'))
              : null)
            : h('div', { className: 'dslb-roots' }, roots.map((root, index) => h(FileRootRow, {
              key: `dslb-root-${index}`,
              index,
              root,
              errors: form.fileRootErrors[index] === undefined
                ? { name: '', path: '' }
                : form.fileRootErrors[index],
              disabled: form.saving,
              t,
              onUpdate: form.updateRoot,
              onRemove: form.removeRoot,
            }))),
          h('div', { className: 'dslb-rootFoot' },
            h('button', {
              type: 'button',
              className: 'dslb-btn',
              disabled: form.saving,
              onClick: form.addRoot,
            }, t('filesRootAdd')))))
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

    /**
     * The short form behind "edit" and "add": an address and a token. In edit
     * mode the token field starts empty on purpose — the Host never reads a
     * token back, so an empty field is how you say "keep the stored one"
     * (`peerTokenKeep` is the placeholder). Nothing here blocks a submit that
     * looks wrong beyond the http(s) prefix; the Host's own sentence is what a
     * failed call shows.
     */
    function PeerForm(props) {
      const { mode, t, initialName, initialUrl, busy, failure, onSubmit, onCancel } = props
      const editing = mode === 'edit'
      const [name, setName] = React.useState(editing ? initialName : '')
      const [url, setUrl] = React.useState(initialUrl)
      const [token, setToken] = React.useState('')
      const [local, setLocal] = React.useState('')
      const submit = () => {
        const trimmedUrl = url.trim()
        const trimmedName = name.trim()
        if (trimmedUrl === '' || !/^https?:\/\/\S+$/i.test(trimmedUrl)) {
          setLocal(t('peerUrlInvalid'))
          return
        }
        if (!editing && trimmedName === '') {
          setLocal(t('peerNameMissing'))
          return
        }
        if (!editing && token.trim() === '') {
          setLocal(t('peerTokenMissing'))
          return
        }
        setLocal('')
        onSubmit({ name: editing ? initialName : trimmedName, url: trimmedUrl, token: token.trim() })
      }
      const field = (label, input, hint) => h('label', { className: 'dslb-formField' },
        h('span', { className: 'dslb-formLabel' }, label),
        input,
        hint === null ? null : h('span', { className: 'dslb-formHint' }, hint))
      return h('div', { className: 'dslb-peerForm' },
        h('div', { className: editing ? 'dslb-peerFormSingle' : 'dslb-peerFormGrid' },
          editing
            ? null
            : field(t('peerName'), h('input', {
              className: 'dslb-input',
              value: name,
              spellCheck: false,
              disabled: busy,
              'aria-label': t('peerName'),
              onChange: (event) => setName(event.currentTarget.value),
            }), null),
          field(t('peerUrl'), h('input', {
            className: 'dslb-input',
            value: url,
            spellCheck: false,
            placeholder: 'http://192.168.1.8:5977',
            disabled: busy,
            'aria-label': t('peerUrl'),
            onChange: (event) => setUrl(event.currentTarget.value),
          }), t('peerUrlHint')),
          field(t('peerToken'), h('input', {
            className: 'dslb-input',
            type: 'password',
            value: token,
            autoComplete: 'off',
            spellCheck: false,
            placeholder: editing ? t('peerTokenKeep') : 'lzb_…',
            disabled: busy,
            'aria-label': t('peerToken'),
            onChange: (event) => setToken(event.currentTarget.value),
          }), null)),
        h('div', { className: 'dslb-peerFormActions' },
          h('button', { type: 'button', className: 'dslb-btn', 'data-tone': 'primary', disabled: busy, onClick: submit },
            t('peerSave')),
          h('button', { type: 'button', className: 'dslb-btn', disabled: busy, onClick: onCancel },
            t('peerCancel'))),
        local === '' && failure === '' ? null : h('div', {
          className: 'dslb-desc dslb-peerWait',
          'data-tone': local === '' ? 'error' : 'warn',
          role: 'alert',
        }, local === '' ? failure : local))
    }

    /**
     * One inbound mirror request. Accepting is a real grant in both directions,
     * so the consequence sentence sits next to the buttons. A request that was
     * answered but not delivered stays on screen with a retry, because the other
     * machine has to hear about it before the pairing is live.
     */
    function MirrorRow(props) {
      const { entry, t, busy, failure, undelivered, onAccept, onReject, onForget } = props
      const rejected = entry.state === 'rejected'
      let actions = null
      if (rejected) {
        actions = h('button', { type: 'button', className: 'dslb-btn', disabled: busy, onClick: () => onForget(entry) },
          t('mirrorForget'))
      } else if (undelivered) {
        actions = h(React.Fragment, null,
          h('button', { type: 'button', className: 'dslb-btn', 'data-tone': 'primary', disabled: busy, onClick: () => onAccept(entry) },
            t('mirrorRetry')),
          h('button', { type: 'button', className: 'dslb-btn', disabled: busy, onClick: () => onForget(entry) },
            t('mirrorForget')))
      } else {
        actions = h(React.Fragment, null,
          h('button', { type: 'button', className: 'dslb-btn', 'data-tone': 'primary', disabled: busy, onClick: () => onAccept(entry) },
            t('mirrorAccept')),
          h('button', { type: 'button', className: 'dslb-btn', disabled: busy, onClick: () => onReject(entry) },
            t('mirrorReject')))
      }
      return h('div', { className: 'dslb-mirrorRow', 'data-mirror': entry.name },
        h('div', { className: 'dslb-main' },
          h('div', { className: 'dslb-title' },
            h('span', { className: 'dslb-name' }, t('mirrorIncoming', { name: entry.name }))),
          h('div', { className: 'dslb-desc' }, t('mirrorConsequence')),
          undelivered ? h('div', { className: 'dslb-desc dslb-peerWait' }, t('mirrorUndelivered')) : null,
          undelivered && entry.error !== '' ? h('div', {
            className: 'dslb-desc dslb-peerWait',
            'data-tone': 'warn',
          }, entry.error) : null,
          entry.capabilities.length === 0 ? null : h('div', { className: 'dslb-chips' },
            entry.capabilities.map((capability, index) => h('span', {
              key: `${capability}-${index}`,
              className: 'dslb-chip',
            }, capabilityLabel(capability, t)))),
          failure === '' ? null : h('div', {
            className: 'dslb-desc dslb-peerWait',
            'data-tone': 'warn',
            role: 'alert',
          }, failure)),
        h('div', { className: 'dslb-side' }, actions))
    }

    /**
     * One outbound peer: where it answers, the last probe, an inline editor and
     * a pending mirror request if this machine asked for a two-way pairing.
     */
    function OutboundRow(props) {
      const {
        peer, t, editing, removing, busy, failure, check, waiting,
        onSubmit, onEdit, onCancelEdit, onCheck,
        onAskRemove, onCancelRemove, onRemove,
      } = props
      const state = h('div', { className: 'dslb-peerState' },
        h(Dot, { on: peer.reachable }),
        h('span', { className: 'dslb-desc' }, peer.reachable ? t('reachable') : t('unreachable')))
      if (editing) {
        return h('div', { className: 'dslb-row', 'data-quiet': '1', 'data-wrap': '1', 'data-peer': peer.name },
          h('div', { className: 'dslb-main' },
            h('div', { className: 'dslb-title' }, h('span', { className: 'dslb-name' }, peer.name)),
            h(PeerForm, {
              mode: 'edit',
              t,
              initialName: peer.name,
              initialUrl: peer.url,
              busy,
              failure,
              onSubmit,
              onCancel: onCancelEdit,
            })),
          state)
      }
      return h('div', { className: 'dslb-row', 'data-quiet': '1', 'data-wrap': '1', 'data-peer': peer.name },
        h('div', { className: 'dslb-main' },
          h('div', { className: 'dslb-title' }, h('span', { className: 'dslb-name' }, peer.name)),
          h('div', { className: 'dslb-desc', title: peer.url },
            h('span', { className: 'dslb-mono' }, peer.url === '' ? t('empty') : peer.url)),
          // A pending mirror under this peer is the other half of a pairing the
          // operator started here; it disappears once the other side accepts.
          waiting === null ? null : h('div', {
            className: 'dslb-desc dslb-peerWait',
            'data-tone': waiting.error === '' ? 'muted' : 'warn',
          }, waiting.error === '' ? t('mirrorWaiting') : t('mirrorFailed', { message: waiting.error })),
          check === null ? null : h('div', {
            className: 'dslb-peerCheck',
            'data-tone': check.ok ? 'ok' : 'error',
          }, `${check.ok ? '●' : '○'} ${check.ok
            ? t('peerCheckOk', { name: check.peerName === '' ? peer.name : check.peerName })
            : t('peerCheckFailed', { error: check.error === '' ? t('unreachable') : check.error })}`),
          failure === '' ? null : h('div', { className: 'dslb-desc', role: 'alert' }, failure)),
        h('div', { className: 'dslb-side dslb-peerActions' },
          state,
          h('button', { type: 'button', className: 'dslb-btn', disabled: busy, onClick: () => onCheck(peer) },
            t('peerCheck')),
          h('button', { type: 'button', className: 'dslb-btn', disabled: busy, onClick: () => onEdit(peer) },
            t('peerEdit')),
          // Same two-step shape as revoking a token: the first click only
          // changes the label, and the row reverts on its own after a few
          // seconds, so a stray click cannot silently delete a peer.
          removing
            ? h(React.Fragment, null,
              h('button', {
                type: 'button',
                className: 'dslb-btn',
                'data-tone': 'danger',
                disabled: busy,
                title: t('peerRemoveHint'),
                onClick: () => onRemove(peer),
              }, t('peerRemoveConfirm')),
              h('button', { type: 'button', className: 'dslb-btn', disabled: busy, onClick: onCancelRemove },
                t('cancel')))
            : h('button', {
              type: 'button',
              className: 'dslb-btn',
              'data-tone': 'danger',
              disabled: busy,
              onClick: () => onAskRemove(peer),
            }, t('peerRemove'))))
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
    /**
     * 3. Peer inventory: inbound credentials, outbound peers (each with an
     * inline editor and a re-probe), the two-way mirror handshake, and the
     * one-time token that creates a peer in the first place. Anything that
     * changes a peer goes through the Host and then re-reads the state — the
     * panel never recomputes a peer from what it hoped happened.
     */
    function Peers(props) {
      const { data, t, reload } = props
      const [confirming, setConfirming] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [failure, setFailure] = React.useState({})
      // Outbound editing/adding keep their own slots so an error next to one
      // peer cannot leak into another row.
      const [editing, setEditing] = React.useState('')
      const [peerBusy, setPeerBusy] = React.useState('')
      const [peerFailure, setPeerFailure] = React.useState('')
      // A failure belongs to one row; without the name it would surface under
      // whichever peer happens to be edited next.
      const [peerFailureFor, setPeerFailureFor] = React.useState('')
      // Removal asks twice, and the question expires: a row left in
      // "confirm" state must not stay armed while the operator is elsewhere.
      const [removeAsk, setRemoveAsk] = React.useState('')
      const removeTimer = React.useRef(null)
      const clearRemoveTimer = () => {
        if (removeTimer.current === null) return
        window.clearTimeout(removeTimer.current)
        removeTimer.current = null
      }
      React.useEffect(() => clearRemoveTimer, [])
      const [checks, setChecks] = React.useState({})
      const [addOpen, setAddOpen] = React.useState(false)
      const [addFailure, setAddFailure] = React.useState('')
      const [addNotice, setAddNotice] = React.useState('')
      // Mirrors answered but not delivered stay on screen under this map, so a
      // retry is one click instead of "ask the other machine to try again".
      const [mirrorBusy, setMirrorBusy] = React.useState('')
      const [mirrorFailure, setMirrorFailure] = React.useState({})
      const mirrors = data.mirrors

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

      const updatePeer = (peer, values) => {
        setPeerBusy(peer.name)
        setPeerFailure('')
        setPeerFailureFor(peer.name)
        // An empty token means "keep the stored one": the Host never reads a
        // token back, so the field is never prefilled.
        void mutate(ROUTE.peer, {
          action: 'update',
          name: peer.name,
          url: values.url,
          token: values.token,
        })
          .then(() => {
            setEditing('')
            return reload()
          })
          .catch((error) => {
            setPeerFailureFor(peer.name)
            setPeerFailure(`${t('peerSaveFailed')}: ${describe(error)}`)
          })
          .finally(() => {
            setPeerBusy('')
          })
      }

      /**
       * A probe answers `{ ok, peer }` where `ok` IS the reachability — an
       * unreachable peer is a normal answer, not a refusal — so this one reads
       * the body instead of going through `mutate`.
       */
      const checkPeer = (peer) => {
        setPeerBusy(peer.name)
        void requestJson(ROUTE.peer, { method: 'POST', body: JSON.stringify({ action: 'check', name: peer.name }) })
          .then((response) => {
            const answer = record(response.body) ?? {}
            const info = record(answer.peer) ?? {}
            const reason = text(info.error, '') || text(answer.error, '')
            setChecks((previous) => ({
              ...previous,
              [peer.name]: {
                ok: info.reachable === true,
                peerName: text(info.peerName, ''),
                error: reason,
              },
            }))
            return reload()
          })
          .catch((error) => {
            setChecks((previous) => ({
              ...previous,
              [peer.name]: { ok: false, peerName: '', error: describe(error) },
            }))
          })
          .finally(() => {
            setPeerBusy('')
          })
      }

      const addPeer = (values) => {
        setPeerBusy('+')
        setAddFailure('')
        void mutate(ROUTE.peer, {
          action: 'add',
          name: values.name,
          url: values.url,
          token: values.token,
        })
          .then((body) => {
            const info = record(body.peer)
            // Saved but silent is a distinct outcome: the credential is stored,
            // the other machine just has not answered yet.
            setAddNotice(info !== null && info.reachable === false ? 'unreachable' : 'saved')
            setAddOpen(false)
            return reload()
          })
          .catch((error) => {
            setAddFailure(`${t('peerAddFailed')}: ${describe(error)}`)
          })
          .finally(() => {
            setPeerBusy('')
          })
      }

      const askRemove = (peer) => {
        clearRemoveTimer()
        setPeerFailure('')
        setPeerFailureFor('')
        setRemoveAsk(peer.name)
        removeTimer.current = window.setTimeout(() => {
          removeTimer.current = null
          setRemoveAsk('')
        }, 5000)
      }

      const cancelRemove = () => {
        clearRemoveTimer()
        setRemoveAsk('')
      }

      const removePeer = (peer) => {
        clearRemoveTimer()
        setRemoveAsk('')
        setPeerBusy(peer.name)
        setPeerFailure('')
        setPeerFailureFor(peer.name)
        void requestJson(ROUTE.peer, {
          method: 'POST',
          body: JSON.stringify({ action: 'remove', name: peer.name }),
        })
          .then((response) => {
            const answer = record(response.body) ?? {}
            // `ok: false` with no error object means "there was nothing left to
            // remove" — the outcome the operator asked for, not a failure.
            if (answer.ok !== true && record(answer.error) !== null) {
              throw mutationError(answer, response.status)
            }
            setAddNotice('removed')
            setPeerBusy('')
            setPeerFailureFor('')
            return reload()
          })
          .catch((error) => {
            setPeerFailureFor(peer.name)
            setPeerFailure(`${t('peerRemoveFailed')}: ${describe(error)}`)
          })
          .finally(() => {
            setPeerBusy('')
          })
      }

      const mirrorAction = (entry, action) => {
        setMirrorBusy(entry.name)
        setMirrorFailure((previous) => ({ ...previous, [entry.name]: '' }))
        const answered = action === 'forget'
          // Forgetting an entry that is already gone answers `{ ok: false }`;
          // that is the state we asked for, so it must not read as an error.
          ? requestJson(ROUTE.mirror, { method: 'POST', body: JSON.stringify({ action, name: entry.name }) })
            .then((response) => record(response.body) ?? {})
          : mutate(ROUTE.mirror, { action, name: entry.name })
        void answered
          .then((body) => {
            if (action === 'accept' && body.delivered === false) {
              // The Host answered and kept the request with its error; the
              // re-read brings back the same row, which explains itself and
              // carries the retry.
              return reload()
            }
            setMirrorFailure((previous) => ({ ...previous, [entry.name]: '' }))
            return reload()
          })
          .catch((error) => {
            setMirrorFailure((previous) => ({
              ...previous,
              [entry.name]: `${t('mirrorFailed')}: ${describe(error)}`,
            }))
          })
          .finally(() => {
            setMirrorBusy('')
          })
      }

      // Everything this machine still owes an answer: a pending request, a
      // refusal kept for the operator to dismiss, and one the Host accepted but
      // could not deliver (it keeps the token and the error, so accepting again
      // retries). Deriving all three from the payload means a page reload never
      // loses a retry.
      const mirrorRows = mirrors === null
        ? []
        : mirrors.in.filter((entry) => entry.state === 'pending'
          || entry.state === 'rejected'
          || (entry.state === 'accepted' && entry.error !== ''))
      const waiting = {}
      if (mirrors !== null) {
        for (const entry of mirrors.out) {
          if (entry.state !== 'pending') continue
          waiting[entry.name] = entry
        }
      }
      const inboundBody = data.inbound.length === 0 && mirrorRows.length === 0
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
        })))
      const mirrorBlock = mirrorRows.length === 0
        ? null
        : h('div', { className: 'dslb-mirrors' }, mirrorRows.map((entry) => h(MirrorRow, {
          key: `mirror-${entry.name}`,
          entry,
          t,
          busy: mirrorBusy === entry.name,
          failure: text(mirrorFailure[entry.name], ''),
          undelivered: entry.state === 'accepted',
          onAccept: (mirror) => mirrorAction(mirror, 'accept'),
          onReject: (mirror) => mirrorAction(mirror, 'reject'),
          onForget: (mirror) => mirrorAction(mirror, 'forget'),
        })))

      return h(Card, { title: t('peers'), hint: t('peersHint') },
        h('div', { className: 'dslb-subcard' },
          h('div', { className: 'dslb-subHead' },
            h('span', { className: 'dslb-subTitle' }, t('inbound')),
            h('span', { className: 'dslb-subHint' }, t('inboundHint'))),
          mirrorBlock,
          inboundBody),
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
              editing: editing === peer.name,
              removing: removeAsk === peer.name,
              busy: peerBusy === peer.name,
              failure: peerFailureFor === peer.name ? peerFailure : '',
              check: Object.prototype.hasOwnProperty.call(checks, peer.name) ? checks[peer.name] : null,
              waiting: Object.prototype.hasOwnProperty.call(waiting, peer.name) ? waiting[peer.name] : null,
              onSubmit: (values) => updatePeer(peer, values),
              onEdit: () => {
                setEditing(peer.name)
                setPeerFailure('')
              },
              onCancelEdit: () => {
                setEditing('')
                setPeerFailure('')
              },
              onCheck: checkPeer,
              onAskRemove: askRemove,
              onCancelRemove: cancelRemove,
              onRemove: removePeer,
            }))),
          h('div', { className: 'dslb-rootFoot' },
            addNotice === ''
              ? null
              : h('span', { className: addNotice === 'unreachable' ? 'dslb-warn' : 'dslb-ok' },
                t(addNotice === 'saved' ? 'peerAddSaved' : (addNotice === 'removed' ? 'peerRemoved' : 'peerAddUnreachable'))),
            addOpen
              ? null
              : h('button', {
                type: 'button',
                className: 'dslb-btn',
                disabled: peerBusy !== '',
                onClick: () => {
                  setAddOpen(true)
                  setAddFailure('')
                  setAddNotice('')
                },
              }, t('peerAdd'))),
          addOpen
            ? h(PeerForm, {
              mode: 'add',
              t,
              initialName: '',
              initialUrl: '',
              busy: peerBusy !== '',
              failure: addFailure,
              onSubmit: addPeer,
              onCancel: () => {
                setAddOpen(false)
                setAddFailure('')
              },
            })
            : null),
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
      // One draft for the whole settings page: the listener card owns the save
      // bar, the files card edits the same payload, so they must share state.
      const form = useSettingsForm({ data, t, applyState })

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
      // how do I change it, who can reach it, what may they transfer, which
      // Sessions are exposed, who is out there.
      return h('div', { className: 'dslb-root', ref: rootRef },
        header,
        h(ErrorBar, { message: state.error, t, onRetry: () => reload() }),
        h(StatusHero, { data, t }),
        h(ListenSettings, { data, t, form }),
        h(Peers, { data, t, reload }),
        h(FilesSettings, { data, t, form }),
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
        h(Discovery, { data, t }),
        h(Audit, { data, t }))
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
