/**
 * Browser half of the LAN bridge panel: one Settings section
 * (`settings.section`) that owns the listener itself — bind address, port,
 * TLS pair and the peer permissions — and, below it, this machine's identity,
 * the Session sharing switches a peer's `session.list` reflects, and the
 * inbound / outbound peer inventory with pairing and revocation. Saving the
 * listener POSTs the whole settings set and replaces the panel state with the
 * state the answer carries, so a clamped port or a failed rebind shows up in
 * the same paint.
 *
 * Every read goes through the Host's own cookie-authenticated route
 * (`api/lan-bridge.*` on the Web listener), never through the bridge
 * listener itself: browsers are not peers, so the bridge's own `/rpc`
 * fence refuses them by design.
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
      },
    }

    /** Host routes, resolved against the document so the app's mount point decides. */
    const ROUTE = {
      state: 'api/lan-bridge.state',
      share: 'api/lan-bridge.share',
      pair: 'api/lan-bridge.pair',
      revoke: 'api/lan-bridge.revoke',
      settings: 'api/lan-bridge.settings',
    }

    /** Poll cadence while the section is on screen and the document visible. */
    const POLL_MS = 3000

    /** Second line of an inbound peer row keeps only this many characters. */
    const INLINE_LIMIT = 120

    const CSS = [
      '.dslb-root{display:flex;flex-direction:column;width:100%;color:var(--dsw-alias-label-primary);',
      'font-size:14px;line-height:20px}',
      '.dslb-group{display:flex;flex-direction:column;width:100%}',
      '.dslb-groupTitle{padding:16px 0 4px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary);font-weight:500}',
      '.dslb-hint{padding:0 0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dslb-row{display:flex;align-items:center;justify-content:space-between;gap:24px;',
      'box-sizing:border-box;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dslb-row:last-child{border-bottom:none}',
      '.dslb-row[data-quiet="1"]{padding:12px 0}',
      '.dslb-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
      '.dslb-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:14px;line-height:20px}',
      '.dslb-title .dslb-desc{flex:none}',
      '.dslb-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dslb-desc{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
      '.dslb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      '.dslb-dot{width:8px;height:8px;border-radius:50%;flex:none;',
      'background:var(--dsw-alias-label-tertiary)}',
      '.dslb-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary)}',
      '.dslb-dot[data-on="0"]{background:var(--dsw-alias-label-tertiary);opacity:.5}',
      '.dslb-field{display:flex;align-items:baseline;justify-content:space-between;gap:24px;',
      'box-sizing:border-box;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dslb-field:last-child{border-bottom:none}',
      '.dslb-fieldKey{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dslb-fieldValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:14px;line-height:20px;font-variant-numeric:tabular-nums;text-align:right}',
      '.dslb-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}',
      '.dslb-chip{padding:0 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dslb-side{display:flex;align-items:center;gap:8px;flex:none}',
      '.dslb-btn{height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;',
      'line-height:28px;white-space:nowrap;cursor:pointer}',
      '.dslb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dslb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dslb-btn:disabled{opacity:.5;cursor:default}',
      '.dslb-btn[data-tone="primary"]{background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dslb-btn[data-tone="primary"]:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-brand-primary)}',
      '.dslb-btn[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
      '.dslb-switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;',
      'padding:0;border:none;border-radius:10px;background:var(--dsw-alias-border-l3);cursor:pointer;',
      'transition:background .15s ease}',
      '.dslb-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dslb-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;',
      'border-radius:50%;background:#fff;transition:transform .15s ease}',
      '.dslb-switch[aria-checked="true"]::after{transform:translateX(16px)}',
      '.dslb-switch:disabled{cursor:progress;opacity:.6}',
      '.dslb-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dslb-form{display:flex;align-items:center;gap:8px;padding:12px 0 16px}',
      '.dslb-input{flex:1;box-sizing:border-box;min-width:0;height:28px;padding:0 8px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.dslb-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.dslb-token{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;margin:4px 0 16px;',
      'padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.dslb-tokenTitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dslb-tokenRow{display:flex;align-items:center;gap:8px}',
      '.dslb-tokenRow .dslb-input{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'font-size:11px}',
      '.dslb-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}',
      '.dslb-alert{display:flex;align-items:center;justify-content:space-between;gap:12px;',
      'box-sizing:border-box;margin:12px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);',
      'font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dslb-empty{padding:12px 0 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dslb-loading{padding:24px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dslb-chipsPick{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:2px 0 6px}',
      '.dslb-chipsPickLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-right:2px}',
      '.dslb-chipPick{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;padding:2px 8px;border-radius:var(--dsw-radius-xs);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dslb-chipPick:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dslb-chipPick[data-current="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dslb-chipPick:disabled{opacity:.5;cursor:default}',
      '.dslb-formGrid{display:flex;flex-wrap:wrap;gap:12px;padding:4px 0 8px}',
      '.dslb-formField{display:flex;flex-direction:column;gap:4px;min-width:180px;flex:1 1 220px}',
      '.dslb-formLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dslb-formHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dslb-check{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;',
      'padding:8px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dslb-check input{flex:none;margin:3px 0 0}',
      '.dslb-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}',
      '@media (prefers-reduced-motion: reduce){.dslb-switch,.dslb-switch::after{transition:none}}',
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
      }
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
        sessions: list(root.sessions).map((entry) => {
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
        }).filter((session) => session !== null),
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
      if (capability === 'rename') return t('capRename')
      if (capability === 'selectModel') return t('capSelectModel')
      return capability
    }

    /**
     * Capabilities a token can carry, in the order the pair form offers them.
     * Mirrors CAPABILITIES in lib/config.js; the Host stays the authority and
     * drops names it does not know.
     */
    const PAIR_CAPABILITIES = ['read', 'prompt', 'control', 'create', 'archive', 'collab']

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

    /** A read-only machine field. */
    function Field(props) {
      return h('div', { className: 'dslb-field' },
        h('span', { className: 'dslb-fieldKey' }, props.label),
        h('span', {
          className: 'dslb-fieldValue',
          title: props.title === undefined ? props.value : props.title,
        }, props.value === '' ? props.t('empty') : props.value))
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

    /** This machine's identity: read-only, no controls. */
    function ThisMachine(props) {
      const { data, t } = props
      const listen = data.listen
      const address = listenLabel(listen)
      const live = listen.protocol === '' || address === '' ? address : `${listen.protocol}://${address}`
      // A listener that is down but still has a configured address is reported
      // as both, so "not listening" never hides where it was supposed to be.
      const shown = listen.listening === false
        ? (address === '' ? t('settingsNotListening') : `${address} · ${t('settingsNotListening')}`)
        : live
      return h('div', { className: 'dslb-group' },
        h('div', { className: 'dslb-groupTitle' }, t('thisMachine')),
        h(Field, { label: t('role'), value: roleLabel(data.role, t), t }),
        h(Field, { label: t('peerName'), value: data.name, t }),
        h(Field, { label: t('listen'), value: shown, t }),
        listen.error === ''
          ? null
          : h('div', { className: 'dslb-warn', role: 'alert' },
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

      return h('div', { className: 'dslb-group' },
        h('div', { className: 'dslb-groupTitle' }, t('settingsTitle')),
        h('div', { className: 'dslb-hint' }, t('settingsHint')),

        h('div', { className: 'dslb-formGrid' },
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

        h('div', { className: 'dslb-row', 'data-quiet': '1' },
          h('div', { className: 'dslb-main' },
            h('div', { className: 'dslb-title' }, t('settingsAllowCreate')),
            h('div', { className: 'dslb-desc' }, t('settingsAllowCreateHint'))),
          h(Switch, {
            checked: draft.allowPeersToCreateSessions,
            label: t('settingsAllowCreate'),
            disabled: saving,
            onChange: () => update('allowPeersToCreateSessions', !draft.allowPeersToCreateSessions),
          })),

        h('div', { className: 'dslb-formGrid' },
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
        h('div', { className: 'dslb-formHint' }, t('settingsTlsHint')),

        h('label', { className: 'dslb-check' },
          h('input', {
            type: 'checkbox',
            checked: draft.insecureHttp,
            disabled: saving,
            onChange: (event) => update('insecureHttp', event.currentTarget.checked),
          }),
          h('span', null, t('settingsInsecure'))),
        insecureWarn
          ? h('div', { className: 'dslb-warn', role: 'note' }, t('settingsInsecureWarning'))
          : null,

        problem === '' ? null : h('div', { className: 'dslb-warn', role: 'note' }, t(problem)),

        listenChanged
          ? h('div', { className: 'dslb-warn', role: 'note' }, t('settingsListenWarning'))
          : null,
        h('div', { className: 'dslb-form' },
          h('button', {
            type: 'button',
            className: 'dslb-btn',
            'data-tone': 'primary',
            disabled: !canSave,
            title: canSave ? undefined : t('settingsSaveBlocked'),
            onClick: save,
          }, saving ? t('settingsSaving') : t('settingsSave'))),
        saved && !dirty ? h('div', { className: 'dslb-ok', role: 'status' }, t('settingsSaved')) : null,
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
        data.restartRequired
          ? h('div', { className: 'dslb-warn', role: 'note' }, t('settingsRestartRequired'))
          : null)
    }

    /**
     * One Session row: identity on the left, the sharing switch on the right.
     * The switch is optimistic and reverts when the route refuses.
     */
    function SessionRow(props) {
      const { session, shared, pending, failure, t, onToggle } = props
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
            checked: shared,
            busy: pending,
            disabled: pending,
            label: t('share'),
            title: `${t('share')} · ${title}`,
            onChange: () => onToggle(session, !shared),
          })))
    }

    /** The sharing switches: the panel's main decision surface. */
    function Sessions(props) {
      const { data, t, overrides, pending, failures, onToggle } = props
      return h('div', { className: 'dslb-group' },
        h('div', { className: 'dslb-groupTitle' }, t('sessions')),
        h('div', { className: 'dslb-hint' }, t('sessionsHint')),
        data.sessions.length === 0
          ? h('div', { className: 'dslb-empty' }, t('noSessions'))
          : data.sessions.map((session) => {
            const id = session.sessionId
            const shared = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : session.shared
            return h(SessionRow, {
              key: id,
              session,
              shared,
              pending: pending[id] === true,
              failure: text(failures[id], ''),
              t,
              onToggle,
            })
          }))
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

      return h('div', { className: 'dslb-group' },
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
          h('div', { className: 'dslb-warn', role: 'note' }, t('tokenOnce')),
          copyState === 'failed' ? h('div', { className: 'dslb-warn', role: 'alert' }, t('copyFailed')) : null,
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
          ? h('div', { className: 'dslb-form' },
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
            }),
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
            h('span', { className: 'dslb-formHint' }, t('pairCapHint')),
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
            }, t('pairCancel')))
          : h('div', { className: 'dslb-form' },
            h('button', {
              type: 'button',
              className: 'dslb-btn',
              onClick: () => {
                setOpen(true)
                setFailure('')
              },
            }, t('pair'))))
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

      return h('div', { className: 'dslb-group' },
        h('div', { className: 'dslb-groupTitle' }, t('peers')),
        h('div', { className: 'dslb-hint' }, t('inbound')),
        data.inbound.length === 0
          ? h('div', { className: 'dslb-empty' }, t('noInbound'))
          : data.inbound.map((peer) => h(InboundRow, {
            key: peer.name,
            peer,
            t,
            confirming: confirming === peer.name,
            busy: busy === peer.name,
            failure: text(failure[peer.name], ''),
            onAsk: () => setConfirming(peer.name),
            onCancel: () => setConfirming(''),
            onRevoke: revoke,
          })),
        h('div', { className: 'dslb-groupTitle' }, t('outbound')),
        data.outbound.length === 0
          ? h('div', { className: 'dslb-empty' }, t('noOutbound'))
          : data.outbound.map((peer) => h(OutboundRow, { key: peer.name, peer, t })),
        h(Pairing, { t, reload }))
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

      const header = h(React.Fragment, null,
        h('style', { key: 'dslb-style' }, CSS),
        h('div', { className: 'dslb-group' },
          h('div', { className: 'dslb-groupTitle' }, t('title')),
          h('div', { className: 'dslb-hint' }, t('subtitle'))))

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

      return h('div', { className: 'dslb-root', ref: rootRef },
        header,
        h(ErrorBar, { message: state.error, t, onRetry: () => reload() }),
        h(ListenSettings, { data, t, applyState }),
        h(ThisMachine, { data, t }),
        h(Sessions, { data, t, overrides, pending, failures, onToggle: toggle }),
        h(Peers, { data, t, reload }))
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
