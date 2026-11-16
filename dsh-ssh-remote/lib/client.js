/**
 * 浏览器半边，两件事：
 *
 * 1. 审批卡样式修正（原有逻辑，见下面第 1 节）；
 * 2. 「设置 → 内置插件 → SSH 主机」页：主机清单 + 接入点。数据面全部走宿主已经
 *    做好的同源维护接口（`/plugin-data/ssh-remote/api`，见 DECISIONS D-41），
 *    浏览器这边只负责表单、表格与请求组装，不复制任何主机/凭据规则。
 *
 * 为什么是 `settings.section`：设置面板左栏是一级页面列表（「通用设置 / 模型 / 内置插件 /
 * Agent 预设 / 认证」都是它的注册项），本页要的就是其中一项、点开即本页。`settings.section`
 * 是 `{ kind: 'list', scope: 'root' }`，左栏按每个注册项的 `label()` 生成导航
 * （`dsh-client-ui-settings-general/lib/client.js:1258-1261` 声明槽，`:1140-1155` 拼导航，
 * `:337` 把选中项连同 `{ close }` 渲染出来）；官方「认证」(`dsh-client-ui-settings-account/
 * lib/client.js:4777-4783`) 与「通用设置」(`...general/lib/client.js:1293-1303`) 都是这么挂的。
 * 「内置插件」页下的子标签槽也考虑过，但那是那一页自己的子标签，用户要的是左栏一级页，
 * 所以只留一个入口（为什么否掉、为什么改，见 DECISIONS D-42）。
 *
 * 为什么单文件：这个文件是浏览器半边唯一的加载入口（`package.json` 的
 * `dsh.client` → `./client`），加载器只认识平台模块表与 tsdown 切出来的
 * `require.async` 分片，普通 `require('./x.js')` 解析不到。拆文件就要引入打包
 * 步骤，与「运行路径零构建」冲突，所以按 §2 记一次例外（见 DECISIONS D-43）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ssh-remote',
  factory: (require) => {
    const exports = {}

    // ═══════════════════════════════════════════════════════════════════
    // 1. 审批卡样式（原有逻辑，只把注入动作抽成 mountStyle 复用）
    // ═══════════════════════════════════════════════════════════════════
    const CARD_CSS_TAG = 'dsh-ssh-remote/approval-card.css'
    const CARD = '[data-question-key] [data-question-scroll]'

    const CARD_CSS = [
      // 0. 正文与头部对齐。.Mbwy4a_body 没有水平内边距，正文容器只有 margin:0 2px，
      //    所以 markdown 内容和代码块贴着卡片左边缘（实测 4px），而头部是 26px。
      //    只给正文那个 div 补，不动 options——复选框在 16px 处本来就是控件的视觉左界。
      `${CARD} > div:first-child:not([role]){padding:0 22px}`,

      // 1. 块间距：16px → 6px，段与段之间不再有半屏空白
      `${CARD} :is(p,ul,ol){margin:6px 0}`,
      `${CARD} :is(ul,ol){padding-left:16px}`,
      `${CARD} li:not(:first-child){margin-top:2px}`,
      `${CARD} hr{margin:10px 0}`,

      // 2. 引用块去掉左侧竖线：这里不是引用，只是一句提醒
      `${CARD} blockquote{margin:6px 0 0;padding-left:0;border-left:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}`,

      // 3. 代码块：标签条 36px → 24px，并且和代码同一底色、一起被圆角裁掉，
      //    免得「sh」浮在灰框外面像个孤立的标签。正文 12px/18px。
      `${CARD} .md-code-block{margin:8px 0;border-radius:var(--dsw-radius-md);overflow:hidden;--dsl-code-block-banner-font:10px/16px var(--dsw-font-family)}`,
      `${CARD} .md-code-block [data-code-block-banner]{padding:2px 10px;background:var(--dsw-alias-markdown-code-block)}`,
      `${CARD} .md-code-block pre{margin:0;padding:6px 10px;font-size:12px;line-height:18px}`,

      // 4. 选项行 40px → 32px；「输入你的答案」对纯勾选卡没有意义，收掉。
      //    `:has()` 是这里唯一晚于 2021 年的选择器（Chrome 105 / Safari 15.4 /
      //    Firefox 121）。明知它新还留着，是因为**它坏得安全**：老浏览器不支持时
      //    整条规则被丢弃，那一行照常显示，跟官方原样一样；换成兼容写法
      //    `> div:last-of-type` 看似稳妥，但它赌「那一行永远是 options 的最后一个
      //    div」——赌错就是悄悄藏掉一个真实控件，比多显示一行糟得多。
      `${CARD} [role="group"] > button{min-height:32px;padding:6px}`,
      `${CARD} [role="group"] > div:has(input,textarea){display:none}`,

      // 5. 给卡片一条边界线，免得和深色背景糊在一起
      '[data-question-key] > section{border:1px solid var(--dsw-alias-border-l2)}',
    ].join('\n')

    /**
     * 往 <head> 里挂一段样式，返回摘掉它的函数。
     *
     * 不要写成「已存在就跳过」：热更新会先销毁旧实例再挂新的，顺序不保证；
     * 若新实例看到旧 <style> 就直接返回，旧实例随后又把它删掉，样式就整段没了。
     * 统一成「先清掉同名标签再挂一份新的」，两种顺序都收敛到同一结果。
     */
    function mountStyle(tagId, css) {
      if (typeof document === 'undefined') return () => {}
      for (const stale of document.querySelectorAll(`style[data-plugin-css="${tagId}"]`)) stale.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-ssh-remote'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // ═══════════════════════════════════════════════════════════════════
    // 2. 设置页：常量、文案、请求
    // ═══════════════════════════════════════════════════════════════════
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { Button, Input, Modal, Tag, IconEditOutlineRegular } = primitives

    /** 本页的文案命名空间；槽注册时 `locale: NS` 让宿主把 `t` 注进组件 props。 */
    const NS = 'sshRemote'

    /**
     * 设置左栏的一级页（与「通用设置 / 模型 / 内置插件 / Agent 预设 / 认证」并列）。
     *
     * 为什么不是「内置插件」里的标签页：那是「内置插件」这一页自己的子标签（官方
     * inventory 用它放插件清单），而用户要的是左栏列表里的一项、点开就是本页。
     * `settings.section` 是 `{ kind: 'list', scope: 'root' }`，左栏按它的 `label()`
     * 生成导航项（`dsh-client-ui-settings-general/lib/client.js:1258-1261` 声明、
     * `:1140-1155` 读 entries 拼导航、`:337` 用 `{ close }` 渲染选中项）。
     * `order` 取现有页之后：认证 -10 / 通用 0 / 模型 10 / 内置插件 15 / 预设 20。
     */
    const SLOT = Object.freeze({ name: 'settings.section', id: 'ssh-remote', order: 30 })

    /**
     * 维护接口前缀。矩阵与 D-41 一致：全 POST + JSON，`hosts/list` 也收 GET。
     * 这里只用相对路径 + `document.baseURI` 拼绝对地址，不写死域名/端口，所以
     * 反向代理、换端口、子路径部署都不用改代码。
     */
    const API_PREFIX = '/plugin-data/ssh-remote/api'
    const ROUTES = Object.freeze({
      hostsList: 'hosts/list',
      hostsSave: 'hosts/save',
      hostsRemove: 'hosts/remove',
      hostsLabel: 'hosts/label',
      hostsTest: 'hosts/test',
      gatewayList: 'gateway/list',
      gatewayRemove: 'gateway/remove',
      gatewaySave: 'gateway/save',
      gatewayAssets: 'gateway/assets',
      gatewayImport: 'gateway/import',
    })
    const API = Object.freeze({ prefix: API_PREFIX, routes: ROUTES, method: 'POST' })

    /** 简体中文文案。 */
    const zh = {
      nav: 'SSH 主机',
      hostsTitle: '主机',
      hostsHint: '这些主机可以直接用于执行与搬运，改完立即生效。',
      colEndpoint: '地址:端口',
      colUser: '账号',
      colLabel: '备注',
      colStatus: '状态',
      colActions: '操作',
      addHost: '新增主机',
      editHost: '编辑主机',
      edit: '编辑',
      test: '测试',
      testing: '测试中…',
      remove: '删除',
      editLabel: '编辑备注',
      connected: '已连接',
      disconnected: '未连接',
      hostsEmpty: '还没有主机。新增一台后可以在这里测试连接、改备注。',
      testOk: '{ms} ms',
      testFailed: '连接失败',
      deleteConfirm: '删除这台主机？',
      confirmDelete: '确认删除',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      close: '关闭',
      fieldAddress: '地址',
      fieldPort: '端口',
      fieldUser: '账号',
      fieldPassword: '密码',
      fieldSecret: '密钥',
      fieldLabel: '备注',
      fieldAppid: 'appid',
      passwordKeep: '留空表示不修改',
      passwordNew: '密码',
      portInvalid: '端口需要是 1–65535 的整数',
      addressRequired: '地址不能为空',
      userRequired: '账号不能为空',
      passwordRequired: '新增主机需要填写密码',
      gatewayTitle: '接入点',
      gatewayHint: '每个接入点各自拉资产、各自一份密钥；导入的主机会记住它来自哪个接入点。',
      addGateway: '新增接入点',
      gatewayEmpty: '还没有接入点。新增一个之后可以拉取资产、勾选导入。',
      gatewayAddHint: '填好后保存，再拉取这个接入点的资产',
      gatewayDeleteConfirm: '删除这个接入点？',
      gatewayRemoved: '已删除（{count} 台主机保留；它们连接时会提示接入点已不存在）',
      fieldName: '名称',
      fieldNameHint: '默认用地址',
      secretKeep: '留空表示不修改',
      secretHint: '密钥只保存在本机加密存储里，页面上不会回显。',
      secretMissing: '密钥未保存，或与当前地址 / appid 不匹配，需要重新填写一次。',
      configured: '已配置',
      notConfigured: '未配置',
      gatewayNotConfiguredHint: '保存后可以拉取资产。',
      pullAssets: '拉取资产',
      pulling: '拉取中…',
      assetsTitle: '资产',
      colName: '名称',
      colAccount: '账号',
      colImported: '状态',
      noAccount: '无可用账号',
      imported: '已导入',
      notImported: '未导入',
      importSelected: '导入选中 {count} 台',
      importing: '导入中…',
      importDone: '导入完成：新增 {created} 台，更新 {updated} 台。',
      importDoneWithSkipped: '导入完成：新增 {created} 台，更新 {updated} 台，跳过 {count} 项。',
      importReasons: '跳过原因：{reasons}',
      assetsEmpty: '没有可导入的资产。',
      assetsSkipped: '另有 {count} 项没有返回。',
      loading: '加载中…',
      retry: '重试',
      errorForbidden: '无法访问本机维护接口，可能需要重新登录。',
      errorNotFound: '接口不存在：插件版本可能不匹配，重启 DSH 后再试。',
      errorNetwork: '请求发不出去：DSH 可能已经退出或正在重启。',
      errorUnknown: '请求失败，请稍后重试。',
    }

    /** English copy. */
    const en = {
      nav: 'SSH hosts',
      hostsTitle: 'Hosts',
      hostsHint: 'These hosts are available to execution and copy tools; changes take effect immediately.',
      colEndpoint: 'Address:port',
      colUser: 'User',
      colLabel: 'Note',
      colStatus: 'Status',
      colActions: 'Actions',
      addHost: 'Add host',
      editHost: 'Edit host',
      edit: 'Edit',
      test: 'Test',
      testing: 'Testing…',
      remove: 'Remove',
      editLabel: 'Edit note',
      connected: 'Connected',
      disconnected: 'Not connected',
      hostsEmpty: 'No hosts yet. Add one to test the connection and edit its note here.',
      testOk: '{ms} ms',
      testFailed: 'Connection failed',
      deleteConfirm: 'Remove this host?',
      confirmDelete: 'Remove',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      close: 'Close',
      fieldAddress: 'Address',
      fieldPort: 'Port',
      fieldUser: 'User',
      fieldPassword: 'Password',
      fieldSecret: 'Key',
      fieldLabel: 'Note',
      fieldAppid: 'appid',
      passwordKeep: 'Leave blank to keep the current password',
      passwordNew: 'Password',
      portInvalid: 'Port must be an integer from 1 to 65535',
      addressRequired: 'Address is required',
      userRequired: 'User is required',
      passwordRequired: 'A new host needs a password',
      gatewayTitle: 'Access points',
      gatewayHint: 'Each access point pulls its own assets and keeps its own key; imported hosts remember which one they came from.',
      addGateway: 'Add access point',
      gatewayEmpty: 'No access points yet. Add one to pull assets and import hosts.',
      gatewayAddHint: 'Fill it in and save, then pull this access point’s assets',
      gatewayDeleteConfirm: 'Remove this access point?',
      gatewayRemoved: 'Removed ({count} hosts kept; connecting them will report the access point is gone)',
      fieldName: 'Name',
      fieldNameHint: 'Defaults to the address',
      secretKeep: 'Leave blank to keep the current key',
      secretHint: 'The key is stored only in the local encrypted store and is never shown here.',
      secretMissing: 'No usable key is stored, or it no longer matches this address / appid. Enter it again.',
      configured: 'Configured',
      notConfigured: 'Not configured',
      gatewayNotConfiguredHint: 'Save the form to list assets.',
      pullAssets: 'List assets',
      pulling: 'Listing…',
      assetsTitle: 'Assets',
      colName: 'Name',
      colAccount: 'User',
      colImported: 'State',
      noAccount: 'No usable account',
      imported: 'Imported',
      notImported: 'Not imported',
      importSelected: 'Import {count} selected',
      importing: 'Importing…',
      importDone: 'Import finished: {created} added, {updated} updated.',
      importDoneWithSkipped: 'Import finished: {created} added, {updated} updated, {count} skipped.',
      importReasons: 'Skipped: {reasons}',
      assetsEmpty: 'No assets to import.',
      assetsSkipped: '{count} more assets were not returned.',
      loading: 'Loading…',
      retry: 'Retry',
      errorForbidden: 'Cannot reach the local maintenance API; you may need to sign in again.',
      errorNotFound: 'Unknown endpoint: the plugin version may be out of date. Restart DSH and retry.',
      errorNetwork: 'The request could not be sent: DSH may have exited or be restarting.',
      errorUnknown: 'The request failed. Please retry.',
    }

    /** 一次接口失败：状态码决定给人看的那句话（403 不能原样抛 JSON）。 */
    class ApiError extends Error {
      constructor(status, message) {
        super(message)
        this.name = 'ApiError'
        this.status = status
      }
    }

    /** 相对路径 + `document.baseURI`：同源、带 cookie、不写死域名与端口。 */
    function apiUrl(route) {
      return new URL(`${API_PREFIX.replace(/^\/+/, '')}/${route}`, document.baseURI).toString()
    }

    /** 调一次维护接口，返回解析后的 JSON；非 2xx 抛 ApiError。 */
    async function callApi(route, body) {
      const response = await fetch(apiUrl(route), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (response.ok !== true) {
        const message = payload !== null && typeof payload.error === 'string' ? payload.error : ''
        throw new ApiError(response.status, message)
      }
      return payload === null ? {} : payload
    }

    /**
     * 把异常翻成一句人话。业务错误（400/500/502 的 `{error}`）原样显示：那是宿主
     * 写好的中文说明，比这里再编一句更准；403/404 与网络失败换成固定文案。
     */
    function describeError(t, error) {
      if (error instanceof ApiError) {
        if (error.status === 403) return t('errorForbidden')
        if (error.status === 404) return t('errorNotFound')
        if (typeof error.message === 'string' && error.message !== '') return error.message
        return t('errorUnknown')
      }
      if (error instanceof TypeError) return t('errorNetwork')
      if (typeof error?.message === 'string' && error.message !== '') return error.message
      return t('errorUnknown')
    }

    /** 端口输入：空或非法都算 invalid，交给调用方决定是不是拦住保存。 */
    function parsePort(value) {
      const port = Number(String(value).trim())
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
    }

    const cx = (...names) => names.filter((name) => name !== undefined && name !== null && name !== '').join(' ')

    /** 备注列显示什么：宿主已经把空备注填成地址了，这里只兜「连地址都没有」的脏数据。 */
    function hostNote(host) {
      if (typeof host.label === 'string' && host.label !== '') return host.label
      return typeof host.address === 'string' ? host.address : ''
    }

    /**
     * 资产表一行的键：`资产 id|账号别名`。
     *
     * 一个账号一行（同一台资产可以有 `example`、`root` 两个账号），勾选状态必须按账号记，
     * 不能按资产记——那样勾一个账号会把整台资产的账号都当成已选。没有可用账号的行用空别名。
     */
    function accountRowKey(row) {
      const alias = row?.account === null || row?.account === undefined ? '' : String(row.account.alias ?? '')
      return `${String(row?.assetId ?? '')}|${alias}`
    }

    /**
     * 资产表「账号」格：只写账号本身。
     *
     * 不附 `用户名 (资产名)` 那种括号后缀（用户 2026-11-15「账号怎么还带有括号…可以只留账号」）：
     * 一行就是一个账号，多账号自然多行，括号里那串既重复又白占宽度。
     */
    function assetAccountCell(t, account) {
      if (account === null || account === undefined) return h('span', { className: 'sshrm-muted' }, t('noAccount'))
      return h('span', { className: 'sshrm-account' }, String(account.username ?? ''))
    }

    /**
     * 资产表「状态」格：与主机表的「已连接 / 未连接」同一种呈现——纯文本 + 状态色。
     *
     * 以前「已导入」是 `Tag`、「未导入」是纯文本，一行一个样子（用户 2026-11-15「要么都是 tag
     * 要么都不是」）。选「都不是」：`Tag` 自带左右内边距，50px 的列里会被裁掉；
     * 而纯文本 + `sshrm-statusOn/Off` 正好和主机表共用一套视觉语言。
     */
    function assetStatusCell(t, imported) {
      return h(
        'span',
        { className: imported === true ? 'sshrm-statusOn' : 'sshrm-statusOff' },
        imported === true ? t('imported') : t('notImported'),
      )
    }

    // ═══════════════════════════════════════════════════════════════════
    // 3. 设置页：组件
    // ═══════════════════════════════════════════════════════════════════

    /** 一条错误条 + 重试按钮（首屏失败、整页刷新失败共用）。 */
    function ErrorBar({ t, text, onRetry }) {
      return h(
        'div',
        { className: 'sshrm-errorBar', role: 'alert' },
        h('span', { className: 'sshrm-errorText' }, text),
        onRetry === undefined
          ? null
          : h(Button, { variant: 'outline', size: 'sm', onClick: onRetry }, t('retry')),
      )
    }

    /** 首屏骨架：三条渐隐横条，位置与两张卡片大致对应。 */
    function LoadingSkeleton({ t }) {
      return h(
        'div',
        { className: 'sshrm-skeleton', role: 'status' },
        h('span', { className: 'sshrm-srOnly' }, t('loading')),
        h('div', { className: 'sshrm-skeletonBar' }),
        h('div', { className: 'sshrm-skeletonBar' }),
        h('div', { className: 'sshrm-skeletonBar' }),
      )
    }

    /**
     * 一行「标签 + 输入框」。两个表单共用一个：`type` / 占位符 / 自动填充策略都靠参数，
     * 免得两处各写一遍、改一处漏一处（密码框的 `new-password` 尤其不能漏）。
     */
    function TextField({ id, label, value, type, placeholder, autoComplete, inputMode, wide, onChange }) {
      return h(
        'div',
        { className: cx('sshrm-field', wide === true ? 'sshrm-fieldWide' : undefined) },
        h('label', { className: 'sshrm-fieldLabel', htmlFor: id }, label),
        h(Input, {
          id,
          className: 'sshrm-input',
          value,
          type: type ?? 'text',
          placeholder,
          autoComplete,
          inputMode,
          spellCheck: false,
          onChange,
        }),
      )
    }

    /**
     * 主机表里的一行。
     *
     * 所有动作都只禁用自己那一格：一个动作在飞时同一行其余按钮一起禁用（避免同一
     * 行两个动作互相踩），别的行、别的卡片完全不受影响。
     */
    function HostRow({ t, host, onEdit, onChanged, onRemoved }) {
      const [busy, setBusy] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [confirming, setConfirming] = React.useState(false)
      const alive = React.useRef(true)
      const timer = React.useRef(undefined)
      const committing = React.useRef(false)

      React.useEffect(
        () => () => {
          alive.current = false
          if (timer.current !== undefined) clearTimeout(timer.current)
        },
        [],
      )

      /** 就地提示；给了 ms 就自动收起（测试结果 3 秒回位）。 */
      function flash(tone, text, ms) {
        if (!alive.current) return
        setNote({ tone, text })
        if (timer.current !== undefined) clearTimeout(timer.current)
        if (ms !== undefined) {
          timer.current = setTimeout(() => {
            if (alive.current) setNote(null)
          }, ms)
        }
      }

      async function runTest() {
        if (busy !== null) return
        setBusy('test')
        setNote(null)
        try {
          const result = await callApi(ROUTES.hostsTest, { id: host.id })
          if (!alive.current) return
          if (result !== null && result.ok === true) {
            flash('ok', t('testOk', { ms: String(result.ms ?? 0) }), 3000)
          } else {
            const text = typeof result?.error === 'string' && result.error !== '' ? result.error : t('testFailed')
            flash('error', text, 3000)
          }
        } catch (error) {
          flash('error', describeError(t, error), 3000)
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      async function saveLabel() {
        if (draft === null || busy !== null) return
        committing.current = true
        setBusy('label')
        const next = draft.trim()
        try {
          const result = await callApi(ROUTES.hostsLabel, { id: host.id, label: next })
          if (!alive.current) return
          if (result !== null && result.host !== undefined && result.host !== null) onChanged(result.host)
          setDraft(null)
        } catch (error) {
          if (alive.current) flash('error', describeError(t, error))
        } finally {
          committing.current = false
          if (alive.current) setBusy(null)
        }
      }

      async function runRemove() {
        if (busy !== null) return
        setBusy('remove')
        try {
          await callApi(ROUTES.hostsRemove, { id: host.id })
          if (alive.current) onRemoved(host.id)
        } catch (error) {
          if (alive.current) {
            flash('error', describeError(t, error))
            setConfirming(false)
          }
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      const labelCell =
        draft === null
          ? h(
              'div',
              { className: 'sshrm-labelView' },
              h('span', { className: 'sshrm-labelText', title: hostNote(host) }, hostNote(host)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sshrm-iconButton',
                  'aria-label': t('editLabel'),
                  title: t('editLabel'),
                  disabled: busy !== null,
                  onClick: () => {
                    setNote(null)
                    setDraft(host.label ?? '')
                  },
                },
                h(IconEditOutlineRegular, { size: 14 }),
              ),
            )
          : h('input', {
              className: 'sshrm-inlineInput',
              value: draft,
              autoFocus: true,
              spellCheck: false,
              'aria-label': t('colLabel'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void saveLabel()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(null)
                }
              },
              onBlur: () => {
                if (!committing.current) setDraft(null)
              },
            })

      const actions = confirming
        ? [
            h('span', { key: 'ask', className: 'sshrm-confirmText' }, t('deleteConfirm')),
            h(
              Button,
              { key: 'ok', variant: 'ghost', size: 'sm', className: 'sshrm-danger', disabled: busy !== null, onClick: runRemove },
              t('confirmDelete'),
            ),
            h(
              Button,
              { key: 'no', variant: 'ghost', size: 'sm', disabled: busy !== null, onClick: () => setConfirming(false) },
              t('cancel'),
            ),
          ]
        : [
            h(Button, { key: 'edit', variant: 'ghost', size: 'sm', disabled: busy !== null, onClick: () => onEdit(host) }, t('edit')),
            h(
              Button,
              { key: 'test', variant: 'ghost', size: 'sm', disabled: busy !== null, onClick: runTest },
              busy === 'test' ? t('testing') : t('test'),
            ),
            h(
              Button,
              {
                key: 'remove',
                variant: 'ghost',
                size: 'sm',
                className: 'sshrm-danger',
                disabled: busy !== null,
                onClick: () => {
                  setNote(null)
                  setConfirming(true)
                },
              },
              t('remove'),
            ),
          ]

      // 一行就是一个 grid 容器（5 列），列宽来自容器上的 `--sshrm-hosts-cols`；
      // 抬头行用同一个模板，改宽度只改那一处（B-46 / D-46 第九节）。
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'sshrm-grid sshrm-gridRow' },
          h(
            'div',
            { className: 'sshrm-gridCell' },
            h('span', { className: 'sshrm-address', title: `${host.address}:${host.port}` }, `${host.address}:${host.port}`),
          ),
          h('div', { className: 'sshrm-gridCell' }, host.user),
          h('div', { className: 'sshrm-gridCell' }, labelCell),
          h(
            'div',
            { className: 'sshrm-gridCell' },
            h(
              'span',
              { className: host.connected === true ? 'sshrm-statusOn' : 'sshrm-statusOff' },
              host.connected === true ? t('connected') : t('disconnected'),
            ),
          ),
          h(
            'div',
            { className: 'sshrm-gridCell sshrm-cellActions' },
            // 三个动作摊开整列（space-between）；二次确认那一行是「一句话 + 两个按钮」，
            // 也摊开会把「取消」顶出卡片，所以那一态单带一个类保持右对齐。
            h('div', { className: cx('sshrm-actions', confirming ? 'sshrm-actionsAsk' : undefined) }, actions),
          ),
        ),
        // 提示行是紧随其后的一整块（不再靠 `colspan` 跨列）：整行宽度；数据行已无左右内边距，
        // 提示行左端与首列左端自然对齐。
        note === null
          ? null
          : h(
              'div',
              { className: 'sshrm-noteRow' },
              h('span', { className: note.tone === 'ok' ? 'sshrm-noteOk' : 'sshrm-noteError', role: 'status' }, note.text),
            ),
      )
    }

    /** 新增/编辑主机。编辑时密码留空＝不改（与 `hosts/save` 的语义一致）。 */
    function HostDialog({ t, host, onClose, onSaved }) {
      const editing = host !== null && host !== undefined
      const [form, setForm] = React.useState(() => ({
        address: editing ? String(host.address ?? '') : '',
        port: String(editing ? (host.port ?? 22) : 22),
        user: editing ? String(host.user ?? '') : '',
        password: '',
        label: editing ? String(host.label ?? '') : '',
      }))
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(null)

      const port = parsePort(form.port)
      const missing =
        form.address.trim() === '' ? 'addressRequired' : form.user.trim() === '' ? 'userRequired' : port === null ? 'portInvalid' : null
      const needsPassword = !editing && form.password === ''
      const canSave = missing === null && !needsPassword && !saving

      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))

      async function submit() {
        if (!canSave) return
        setSaving(true)
        setError(null)
        try {
          const body = {
            address: form.address.trim(),
            port,
            user: form.user.trim(),
            label: form.label.trim(),
          }
          if (editing) body.id = host.id
          if (form.password !== '') body.password = form.password
          const result = await callApi(ROUTES.hostsSave, body)
          if (result !== null && result.host !== undefined && result.host !== null) onSaved(result.host)
          onClose()
        } catch (failure) {
          setError(describeError(t, failure))
        } finally {
          setSaving(false)
        }
      }

      /** 表单字段：`id` 前缀区分两张卡，其余照 TextField 的参数传。 */
      const field = (key, label, options) =>
        h(TextField, { key, id: `sshrm-${key}`, label, value: form[key], onChange: set(key), ...(options ?? {}) })

      const footer = h(
        React.Fragment,
        null,
        h(Button, { variant: 'outline', disabled: saving, onClick: onClose }, t('cancel')),
        h(Button, { variant: 'primary', disabled: !canSave, onClick: () => void submit() }, saving ? t('saving') : t('save')),
      )

      return h(
        Modal,
        {
          open: true,
          onClose: () => {
            if (!saving) onClose()
          },
          title: editing ? t('editHost') : t('addHost'),
          closeLabel: t('close'),
          footer,
        },
        h(
          'div',
          {
            className: 'sshrm-fields',
            onKeyDown: (event) => {
              if (event.key === 'Enter' && event.target?.tagName !== 'TEXTAREA') {
                event.preventDefault()
                void submit()
              }
            },
          },
          field('address', t('fieldAddress'), { wide: true }),
          field('port', t('fieldPort'), { inputMode: 'numeric' }),
          field('user', t('fieldUser')),
          field('password', t('fieldPassword'), {
            type: 'password',
            // 新增时必须填，占位符就别写「留空＝不改」；只有编辑态才这么提示。
            placeholder: editing ? t('passwordKeep') : undefined,
            autoComplete: 'new-password',
          }),
          field('label', t('fieldLabel'), { wide: true }),
          error === null ? null : h('p', { className: 'sshrm-formError', role: 'alert' }, error),
          needsPassword ? h('p', { className: 'sshrm-formHint' }, t('passwordRequired')) : null,
          missing === null ? null : h('p', { className: 'sshrm-formHint' }, t(missing)),
        ),
      )
    }

    /** A 区：主机表 + 新增/编辑弹窗。 */
    function HostsCard({ t, hosts, onChanged, onRemoved }) {
      const [dialog, setDialog] = React.useState(null)

      // 列表就是「抬头行 + 每行一个 grid 容器」：两者共用容器上那一个列宽模板。
      const rows =
        hosts.length === 0
          ? h('p', { className: 'sshrm-empty' }, t('hostsEmpty'))
          : h(
              'div',
              { className: 'sshrm-hostsTable' },
              h(
                'div',
                { className: 'sshrm-grid sshrm-gridHead' },
                h('div', { className: 'sshrm-gridCell' }, t('colEndpoint')),
                h('div', { className: 'sshrm-gridCell' }, t('colUser')),
                h('div', { className: 'sshrm-gridCell' }, t('colLabel')),
                h('div', { className: 'sshrm-gridCell' }, t('colStatus')),
                h('div', { className: 'sshrm-gridCell sshrm-cellActions' }, t('colActions')),
              ),
              hosts.map((host) =>
                h(HostRow, {
                  key: host.id,
                  t,
                  host,
                  onEdit: (target) => setDialog({ host: target }),
                  onChanged,
                  onRemoved,
                }),
              ),
            )

      return h(
        'section',
        { className: 'sshrm-card', 'data-ssh-remote-card': 'hosts' },
        h(
          'div',
          { className: 'sshrm-cardHead' },
          h(
            'div',
            { className: 'sshrm-cardTitles' },
            h('h3', { className: 'sshrm-cardTitle' }, t('hostsTitle')),
            h('p', { className: 'sshrm-hint' }, t('hostsHint')),
          ),
          h(Button, { variant: 'primary', size: 'sm', onClick: () => setDialog({ host: null }) }, t('addHost')),
        ),
        rows,
        dialog === null
          ? null
          : h(HostDialog, {
              key: dialog.host === null ? 'new' : dialog.host.id,
              t,
              host: dialog.host,
              onClose: () => setDialog(null),
              onSaved: onChanged,
            }),
      )
    }

    /**
     * 一个接入点：名称 / 地址 / appid / 端口 / 密钥 + 保存 / 拉取资产 / 删除。
     *
     * `gateway === null` 是「新增接入点」那张还没落盘的表单：字段一样，多一个「取消」，
     * 保存成功后由父组件把它换成列表里的一张真卡片。
     * 每个接入点各自拉自己的资产（不共享状态、不共享密钥），勾选与导入也只影响这一个。
     */
    function GatewayItem({ t, gateway, onSaved, onRemoved, onHostsChanged, onCancel }) {
      const editing = gateway !== null && gateway !== undefined
      const [form, setForm] = React.useState(() => ({
        label: String(gateway?.label ?? ''),
        address: String(gateway?.address ?? ''),
        appid: String(gateway?.appid ?? ''),
        port: String(gateway?.port ?? 2222),
        secret: '',
      }))
      const [busy, setBusy] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [confirming, setConfirming] = React.useState(false)
      const [assets, setAssets] = React.useState(null)
      const [assetsSkipped, setAssetsSkipped] = React.useState(0)
      const [selected, setSelected] = React.useState(() => new Set())
      const alive = React.useRef(true)

      React.useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )

      const port = parsePort(form.port)
      const canSave = form.address.trim() !== '' && form.appid.trim() !== '' && port !== null && busy === null
      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))

      async function save() {
        if (!canSave) return
        setBusy('save')
        setNote(null)
        try {
          const body = {
            address: form.address.trim(),
            appid: form.appid.trim(),
            port,
            label: form.label.trim() === '' ? form.address.trim() : form.label.trim(),
          }
          // 带 id＝改这一个；不带 id＝新建（服务端按地址派生 id）。
          if (editing) body.id = gateway.id
          if (form.secret !== '') body.secret = form.secret
          const result = await callApi(ROUTES.gatewaySave, body)
          if (!alive.current) return
          // 密钥框立刻清空：保存即写进 vault，页面上不再留第二份明文。
          setForm((prev) => ({ ...prev, secret: '', label: String(result?.gateway?.label ?? prev.label) }))
          setNote({ tone: 'ok', text: t('saved') })
          onSaved(result?.gateway ?? null, result?.created === true)
        } catch (error) {
          if (alive.current) setNote({ tone: 'error', text: describeError(t, error) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      /** 删掉这一个（二次确认）。从它导入的主机不删，服务端会回保留了几台。 */
      async function remove() {
        if (!editing || busy !== null) return
        setBusy('remove')
        try {
          const result = await callApi(ROUTES.gatewayRemove, { id: gateway.id })
          if (!alive.current) return
          onRemoved(gateway.id, Number.isFinite(Number(result?.hostsKept)) ? Number(result.hostsKept) : 0)
        } catch (error) {
          if (alive.current) {
            setNote({ tone: 'error', text: describeError(t, error) })
            setConfirming(false)
          }
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      /** 拉这一个接入点的资产清单；`quiet` 用于导入完成后刷新「已导入」标记，不盖掉结果提示。 */
      async function pull(options) {
        if (!editing) return
        const quiet = options !== undefined && options.quiet === true
        if (busy !== null && !quiet) return
        setBusy('assets')
        if (!quiet) setNote(null)
        try {
          const result = await callApi(ROUTES.gatewayAssets, { gatewayId: gateway.id })
          if (!alive.current) return
          const list = Array.isArray(result?.assets) ? result.assets : []
          setAssets(list)
          setAssetsSkipped(Number.isFinite(result?.skipped) ? Number(result.skipped) : 0)
          // 勾选状态跟着「资产 × 账号」走：重新拉一次之后，已导入 / 没有账号的那行自动掉勾。
          setSelected((prev) => {
            const next = new Set()
            for (const key of prev) {
              if (list.some((row) => accountRowKey(row) === key && row.imported !== true && row.account !== null)) {
                next.add(key)
              }
            }
            return next
          })
        } catch (error) {
          if (alive.current) setNote({ tone: 'error', text: describeError(t, error) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      async function runImport() {
        // 勾的是「资产 × 账号」，提交时也是这两样：`account` 是账号别名（换连接凭据要用它）。
        const items = (assets ?? [])
          .filter((row) => row.account !== null && row.account !== undefined && selected.has(accountRowKey(row)))
          .map((row) => ({ assetId: String(row.assetId), account: String(row.account.alias) }))
        if (!editing || items.length === 0 || busy !== null) return
        setBusy('import')
        setNote(null)
        let done = false
        try {
          const result = await callApi(ROUTES.gatewayImport, { gatewayId: gateway.id, items })
          if (!alive.current) return
          const imported = Array.isArray(result?.imported) ? result.imported : []
          const created = imported.filter((row) => row?.created === true).length
          const updated = imported.length - created
          const skipped = Array.isArray(result?.skipped) ? result.skipped : []
          const reasons = skipped
            .map((row) => String(row?.reason ?? '').trim())
            .filter((reason) => reason !== '')
            .slice(0, 3)
            .join('；')
          const text =
            skipped.length === 0
              ? t('importDone', { created: String(created), updated: String(updated) })
              : t('importDoneWithSkipped', {
                  created: String(created),
                  updated: String(updated),
                  count: String(skipped.length),
                })
          // 跳过原因另起一行：中文里「。」后接空格很别扭，英文里不隔开又粘在一起。
          setNote({
            tone: skipped.length === 0 ? 'ok' : 'warn',
            text: reasons === '' ? text : `${text}\n${t('importReasons', { reasons })}`,
          })
          done = true
        } catch (error) {
          if (alive.current) setNote({ tone: 'error', text: describeError(t, error) })
        } finally {
          if (alive.current) setBusy(null)
        }
        if (!done) return
        await onHostsChanged()
        await pull({ quiet: true })
      }

      function toggle(key, checked) {
        setSelected((prev) => {
          const next = new Set(prev)
          if (checked) next.add(key)
          else next.delete(key)
          return next
        })
      }

      /** 字段 id 带接入点 id（或 `new`），同一页上多个表单不会撞 id。 */
      const field = (key, label, options) =>
        h(TextField, {
          key,
          id: `sshrm-gw-${editing ? gateway.id : 'new'}-${key}`,
          label,
          value: form[key],
          onChange: set(key),
          ...(options ?? {}),
        })

      const statusTag = editing
        ? h(
            Tag,
            { tone: gateway.configured === true ? 'info' : 'neutral' },
            gateway.configured === true ? t('configured') : t('notConfigured'),
          )
        : null

      const actions = confirming
        ? [
            h('span', { key: 'ask', className: 'sshrm-confirmText' }, t('gatewayDeleteConfirm')),
            h(
              Button,
              { key: 'ok', variant: 'ghost', size: 'sm', className: 'sshrm-danger', disabled: busy !== null, onClick: () => void remove() },
              t('confirmDelete'),
            ),
            h(Button, { key: 'no', variant: 'ghost', size: 'sm', disabled: busy !== null, onClick: () => setConfirming(false) }, t('cancel')),
          ]
        : [
            h(
              Button,
              { key: 'save', variant: 'primary', size: 'sm', disabled: !canSave, onClick: () => void save() },
              busy === 'save' ? t('saving') : t('save'),
            ),
            editing
              ? h(
                  Button,
                  { key: 'pull', variant: 'outline', size: 'sm', disabled: busy !== null, onClick: () => void pull() },
                  busy === 'assets' ? t('pulling') : t('pullAssets'),
                )
              : null,
            editing
              ? h(
                  Button,
                  {
                    key: 'remove',
                    variant: 'ghost',
                    size: 'sm',
                    className: 'sshrm-danger',
                    disabled: busy !== null,
                    onClick: () => {
                      setNote(null)
                      setConfirming(true)
                    },
                  },
                  t('remove'),
                )
              : null,
            editing
              ? null
              : h(Button, { key: 'cancel', variant: 'ghost', size: 'sm', disabled: busy !== null, onClick: () => onCancel?.() }, t('cancel')),
          ].filter(Boolean)

      // 资产表与主机表同构：抬头行 + 每行一个 grid 容器，列宽模板在 `.sshrm-assetTable` 上。
      const assetsTable =
        assets === null
          ? null
          : assets.length === 0
            ? h('p', { className: 'sshrm-empty' }, t('assetsEmpty'))
            : h(
                'div',
                { className: 'sshrm-assetTable' },
                h(
                  'div',
                  { className: 'sshrm-grid sshrm-gridHead' },
                  h('div', { className: 'sshrm-gridCell' }, ''),
                  h('div', { className: 'sshrm-gridCell' }, t('colName')),
                  h('div', { className: 'sshrm-gridCell' }, t('colEndpoint')),
                  h('div', { className: 'sshrm-gridCell' }, t('colAccount')),
                  h('div', { className: 'sshrm-gridCell' }, t('colImported')),
                ),
                assets.map((row) => {
                  const key = accountRowKey(row)
                  const imported = row.imported === true
                  const account = row.account ?? null
                  const username = account === null ? '' : String(account.username ?? '')
                  // 整行可点：与勾选框的 `disabled` 是同一组条件（已导入 / 无账号 / 正在忙的行点了什么都不做），
                  // 只有可勾的行才带 `sshrm-gridRowPick`，观感（指针 + hover 底色）也只加在这类行上。
                  const pickable = imported === false && account !== null && busy === null
                  return h(
                    'div',
                    {
                      key,
                      className: cx('sshrm-grid sshrm-gridRow', pickable ? 'sshrm-gridRowPick' : undefined),
                      // 行点击是勾选框之外的**附加**快捷方式：点行内任意非勾选框位置切换勾选状态。
                      // `toggle(key, checked)` 收的是目标状态（不是「切换」），所以这里现算 `!selected.has(key)`；
                      // 不可勾的行直接返回，不调 `toggle`、不报错。
                      onClick: () => {
                        if (!pickable) return
                        toggle(key, !selected.has(key))
                      },
                    },
                    h(
                      'div',
                      { className: 'sshrm-gridCell' },
                      h('input', {
                        type: 'checkbox',
                        className: 'sshrm-check',
                        // 一个账号一行：同一台资产的两行必须能被读屏/测试区分开。
                        'aria-label':
                          username === '' ? String(row.name ?? row.address ?? '') : `${String(row.address ?? '')} · ${username}`,
                        checked: selected.has(key),
                        // 已导入的不必再导；没有可用账号的那行只用来提示，不许勾。
                        disabled: imported || account === null || busy !== null,
                        // 点勾选框时只走 `onChange`：事件不再冒泡到行容器，否则一次点击会切两次（等于没点）。
                        onClick: (event) => event.stopPropagation(),
                        onChange: (event) => toggle(key, event.target.checked),
                      }),
                    ),
                    h('div', { className: 'sshrm-gridCell', title: String(row.name ?? '') }, String(row.name ?? '')),
                    h(
                      'div',
                      { className: 'sshrm-gridCell' },
                      h('span', { className: 'sshrm-address' }, String(row.address ?? '')),
                    ),
                    h('div', { className: 'sshrm-gridCell', title: username }, assetAccountCell(t, account)),
                    h('div', { className: 'sshrm-gridCell' }, assetStatusCell(t, imported)),
                  )
                }),
              )

      const title = editing ? String(gateway.label ?? '').trim() || t('notConfigured') : t('addGateway')
      const subtitle = editing ? `${String(gateway.address ?? '') || '—'}:${gateway.port}` : t('gatewayAddHint')

      return h(
        'div',
        { className: 'sshrm-gateway', 'data-ssh-remote-gateway': editing ? gateway.id : 'new' },
        h(
          'div',
          { className: 'sshrm-cardHead' },
          h(
            'div',
            { className: 'sshrm-cardTitles' },
            h('h4', { className: 'sshrm-subTitle' }, title),
            h('p', { className: 'sshrm-hint' }, subtitle),
          ),
          statusTag,
        ),
        h(
          'div',
          { className: 'sshrm-fields' },
          field('label', t('fieldName'), { wide: true, placeholder: t('fieldNameHint') }),
          field('address', t('fieldAddress'), { wide: true }),
          field('appid', t('fieldAppid')),
          field('port', t('fieldPort'), { inputMode: 'numeric' }),
          field('secret', t('fieldSecret'), {
            type: 'password',
            placeholder: t('secretKeep'),
            autoComplete: 'new-password',
            wide: true,
          }),
          h('p', { className: 'sshrm-hint sshrm-fieldWide' }, t('secretHint')),
          // 只在「配置已经存过、但密钥不可用」时提醒：初次填写表单时不该先吓人一跳。
          editing && gateway.hasSecret === false && String(gateway.address ?? '') !== ''
            ? h('p', { className: 'sshrm-formHint sshrm-fieldWide' }, t('secretMissing'))
            : null,
        ),
        h(
          'div',
          { className: 'sshrm-formActions' },
          actions,
          note === null
            ? null
            : h(
                'span',
                {
                  className: cx(
                    'sshrm-inlineNote',
                    note.tone === 'error' ? 'sshrm-noteError' : note.tone === 'warn' ? 'sshrm-noteWarn' : 'sshrm-noteOk',
                  ),
                  role: 'status',
                },
                note.text,
              ),
        ),
        editing && gateway.configured === true
          ? h(
              'div',
              { className: 'sshrm-assets' },
              assets === null ? null : h('h5', { className: 'sshrm-subTitle' }, t('assetsTitle')),
              assetsTable,
              assetsSkipped === 0 ? null : h('p', { className: 'sshrm-hint' }, t('assetsSkipped', { count: String(assetsSkipped) })),
              assets === null
                ? null
                : h(
                    'div',
                    { className: 'sshrm-formActions' },
                    h(
                      Button,
                      {
                        variant: 'primary',
                        size: 'sm',
                        disabled: selected.size === 0 || busy !== null,
                        onClick: () => void runImport(),
                      },
                      busy === 'import' ? t('importing') : t('importSelected', { count: String(selected.size) }),
                    ),
                  ),
            )
          : editing
            ? h('p', { className: 'sshrm-hint' }, t('gatewayNotConfiguredHint'))
            : null,
      )
    }

    /** B 区：接入点列表（每个各自拉资产）+ 「新增接入点」。 */
    function GatewaysCard({ t, gateways, onSaved, onRemoved, onHostsChanged }) {
      const [adding, setAdding] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const list = Array.isArray(gateways) ? gateways : []

      const removed = React.useCallback(
        (id, hostsKept) => {
          setNote({ tone: 'warn', text: t('gatewayRemoved', { count: String(hostsKept) }) })
          onRemoved(id)
        },
        [t, onRemoved],
      )

      return h(
        'section',
        { className: 'sshrm-card', 'data-ssh-remote-card': 'gateways' },
        h(
          'div',
          { className: 'sshrm-cardHead' },
          h(
            'div',
            { className: 'sshrm-cardTitles' },
            h('h3', { className: 'sshrm-cardTitle' }, t('gatewayTitle')),
            h('p', { className: 'sshrm-hint' }, t('gatewayHint')),
          ),
          adding
            ? null
            : h(Button, { variant: 'primary', size: 'sm', disabled: false, onClick: () => setAdding(true) }, t('addGateway')),
        ),
        note === null
          ? null
          : h('p', { className: cx('sshrm-inlineNote', 'sshrm-noteWarn'), role: 'status' }, note.text),
        list.length === 0 && !adding ? h('p', { className: 'sshrm-empty' }, t('gatewayEmpty')) : null,
        list.map((gateway) =>
          h(GatewayItem, { key: gateway.id, t, gateway, onSaved, onRemoved: removed, onHostsChanged }),
        ),
        adding
          ? h(GatewayItem, {
              key: 'new',
              t,
              gateway: null,
              onSaved: (gateway, created) => {
                if (created) setAdding(false)
                onSaved(gateway, created)
              },
              onRemoved: removed,
              onHostsChanged,
              onCancel: () => setAdding(false),
            })
          : null,
      )
    }
    /**
     * 整页：首屏一次拉齐（主机清单 + 接入点状态），之后再按动作就地更新。
     *
     * 首屏失败只影响首屏：已经拿到的数据继续显示，错误条挂在上方，重试只重拉清单。
     */
    function SettingsTab(props) {
      const t = props.t
      const tRef = React.useRef(t)
      tRef.current = t
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState(null)
      const alive = React.useRef(true)

      React.useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )

      const load = React.useCallback(async () => {
        if (!alive.current) return
        setLoading(true)
        setLoadError(null)
        try {
          const [list, gateways] = await Promise.all([callApi(ROUTES.hostsList, {}), callApi(ROUTES.gatewayList, {})])
          if (!alive.current) return
          setData({
            hosts: Array.isArray(list?.hosts) ? list.hosts : [],
            gateways: Array.isArray(gateways?.gateways) ? gateways.gateways : [],
          })
        } catch (error) {
          if (alive.current) setLoadError(error)
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const changeHost = React.useCallback((host) => {
        setData((prev) => {
          if (prev === null || host === null || host === undefined) return prev
          const index = prev.hosts.findIndex((row) => row.id === host.id)
          const hosts =
            index === -1
              ? [...prev.hosts, host]
              : prev.hosts.map((row, position) => (position === index ? { ...row, ...host } : row))
          return { ...prev, hosts }
        })
      }, [])

      const removeHost = React.useCallback((id) => {
        setData((prev) => (prev === null ? prev : { ...prev, hosts: prev.hosts.filter((row) => row.id !== id) }))
      }, [])

      /** 保存一个接入点：新建的追加到列表，改过的就地替换（key 不变，卡片里的状态不丢）。 */
      const changeGateway = React.useCallback((gateway, created) => {
        if (gateway === null || gateway === undefined) return
        setData((prev) => {
          if (prev === null) return prev
          const list = Array.isArray(prev.gateways) ? prev.gateways : []
          const index = list.findIndex((row) => row.id === gateway.id)
          const gateways =
            index === -1
              ? [...list, gateway]
              : list.map((row, position) => (position === index ? { ...row, ...gateway } : row))
          return { ...prev, gateways }
        })
        if (created) setLoadError(null)
      }, [])

      const removeGateway = React.useCallback((id) => {
        setData((prev) =>
          prev === null ? prev : { ...prev, gateways: (prev.gateways ?? []).filter((row) => row.id !== id) },
        )
      }, [])

      const errorBar =
        loadError === null
          ? null
          : h(ErrorBar, {
              t,
              text: describeError(tRef.current, loadError),
              onRetry: () => {
                void load()
              },
            })

      if (data === null) {
        return h(
          'div',
          { className: 'sshrm-section' },
          h('h2', { className: 'sshrm-pageTitle' }, t('nav')),
          loading ? h(LoadingSkeleton, { t }) : null,
          errorBar,
        )
      }

      return h(
        'div',
        { className: 'sshrm-section' },
        h('h2', { className: 'sshrm-pageTitle' }, t('nav')),
        errorBar,
        h(HostsCard, { t, hosts: data.hosts, onChanged: changeHost, onRemoved: removeHost }),
        h(GatewaysCard, {
          t,
          gateways: data.gateways,
          onSaved: changeGateway,
          onRemoved: removeGateway,
          onHostsChanged: load,
        }),
      )
    }

    // ═══════════════════════════════════════════════════════════════════
    // 4. 设置页样式（全部走宿主 token，深浅色由 token 自己切换）
    // ═══════════════════════════════════════════════════════════════════
    const SETTINGS_CSS_TAG = 'dsh-ssh-remote/settings.css'
    const SETTINGS_CSS = [
      // 宽度：不在自己的容器上设上限。设置面板的实际可用宽度由外壳决定——
      // `.VOzbGW_panel{width:800px}`、`.VOzbGW_nav{width:188px}`、`.VOzbGW_options{padding:0 24px 24px}`
      // → 800 − 188 − 48 = 564px（`dsh-client-ui-settings-general/lib/client.js` 的 SettingsRoot.module.css）。
      // 这里只要求「铺满父容器」，不再写 max-width（写窄了在宽屏上就是右边一片空白）。
      '.sshrm-section{display:flex;flex-direction:column;gap:14px;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.sshrm-pageTitle{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.sshrm-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}',
      '.sshrm-cardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}',
      '.sshrm-cardTitles{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.sshrm-cardTitle{margin:0;font-size:14px;font-weight:600;line-height:22px}',
      '.sshrm-subTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}',
      // 一个接入点一块：块与块之间只用一条细分隔线，不再套第二层卡片边框（嵌套边框在 564px 里太挤）。
      '.sshrm-gateway{display:flex;flex-direction:column;gap:10px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.sshrm-cardHead + .sshrm-gateway{padding-top:0;border-top:0}',
      '.sshrm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.sshrm-empty{margin:0;padding:4px 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      // 两张列表都用 CSS Grid（用户 2026-11-15 B-46：「后续的前端技术尽量使用现代布局方式」）。
      // 列宽只在列表容器上定义一次（`--sshrm-hosts-cols` / `--sshrm-asset-cols`），
      // 抬头行与每一行数据都是 `.sshrm-grid`，`grid-template-columns` 只引用那个变量——
      // 改列宽只改一处，不会出现「表头一份、数据行另一份」的漂移。
      // 为什么不再用 table：百分比列、单元格 padding、表格的固定布局三者互相牵制，
      // 单元格里的行内输入框（content-box + min-width）必然比内容区宽，被 `overflow:hidden`
      // 剪成半截；grid 的列宽一次定死，单元格 `min-width:0` 就不会把轨道撑破（D-46 第九节）。
      '.sshrm-hostsTable{--sshrm-hosts-cols:128px 64px minmax(0, 1fr) 50px 84px}',
      // 资产表也按像素定宽（用户 2026-11-16「下面也应该改为像素啊」「原因是本来设置页就是固定宽度的」
      // 「直接用像素即可」「保持统一」）：设置页的内容区宽度由外壳固定（564px 减卡片内边距），
      // 百分比只是把「量出来的宽度」和实际渲染脱开；同类列直接与主机表取同一个数——
      // 地址:端口 128px / 账号 64px / 状态 50px，名称列照旧吃剩余（`minmax(0, 1fr)`），
      // 勾选列仍是 28px（14px 复选框 + 12px 间距 + 2px 余量）。模板里不再有任何百分比。
      '.sshrm-assetTable{--sshrm-asset-cols:28px minmax(0, 1fr) 128px 64px 50px}',
      // 资产列表限高 + 内部滚动（用户 2026-11-16「获取的资产列表 可以给个最高高度」）：
      // 资产多时列表自己滚，不再把卡片顶长、要滚整页才能操作（D-46 第十五节）。
      // 320px 的来源：表头 34px（28px 行高 + 6px 下内边距）+ 7 行 × 40px = 314px，留 6px 余量；
      // 这是默认值，用户以后给数就改这一个数。
      // 单独一条规则而不是并进上面那条：列宽模板保持「只定义一处」的原文形态，
      // 既有那条钉住列宽模板原文的断言也不用改。
      // `overflow-x:hidden`：列宽是像素模板，横向不滚；滚动用原生行为，不自绘滚动条。
      '.sshrm-assetTable{max-height:320px;overflow-y:auto;overflow-x:hidden}',
      '.sshrm-grid{display:grid;align-items:center;min-width:0}',
      '.sshrm-hostsTable .sshrm-grid{grid-template-columns:var(--sshrm-hosts-cols)}',
      '.sshrm-assetTable .sshrm-grid{grid-template-columns:var(--sshrm-asset-cols)}',
      // 所有单元格共用这一个类：`min-width:0` 让内容可压缩（grid 子项默认 min-width:auto 会把轨道撑破），
      // 真的放不下就省略号，全文由 `title` 在悬停时给出。
      '.sshrm-gridCell{box-sizing:border-box;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 分隔线画在**行容器的上界**，不用 `:last-child` 收尾：提示行 `.sshrm-noteRow` 是行容器的
      // 兄弟节点（紧随其所属那一行），所以「最后一行」不一定是最后一个子元素——
      // 用 `:last-child`（或 `:last-of-type`，noteRow 也是 div）收尾时，最后一行带提示就会失效、
      // 在行下多画一条线。画上界就没有「收尾」这件事：抬头行紧接的第一行不画，其余每行一条，
      // 永远连续；单元格靠 `align-items:center` 按自身内容居中（等价于原来的 `vertical-align:middle`）。
      //
      // 高度与内边距（用户 2026-11-16：「左右不用 padding 可以移除单元格 padding」「直接用行高 40 就行了」）：
      // - 单元格一律零内边距（`.sshrm-gridCell` 里没有 `padding`），所以轨道宽 = 内容可用宽；
      // - 行高由行容器的 `height` 定：数据行 40px，表头 28px + 6px 下内边距保持与数据行的呼吸；
      // - 表头字号 / 颜色 / 对齐都继承自这一行容器，不再靠「单元格规则」给节奏。
      '.sshrm-gridHead{border-bottom:.5px solid var(--dsw-alias-border-l2);height:28px;padding-bottom:6px;text-align:left;font-weight:500;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      // 表头吸顶（同一次真机反馈）：资产列表是唯一的滚动容器，表头在它内部 `position:sticky;top:0`，
      // 滚上来的行被表头压住，仍然知道哪一列是什么。
      // 为什么带 `.sshrm-assetTable` 前缀而不是直接写 `.sshrm-gridHead`：主机表**不**是滚动容器，
      // 无前缀的 sticky 会相对设置页的滚动容器 `.VOzbGW_options{overflow-y:auto}`（settings-general
      // 外壳）生效，主机表表头会在整页滚动时浮在自己那几行上面——主机表是短列表，不需要也没有要求吸顶。
      // 底色必须不透明，否则滚过去的行会透出来：用卡片自己的底色 token
      // `--dsw-alias-settings-card-fill`（= `--dsw-alias-bg-layer-2`，浅色 rgb(255,255,255) /
      // 深色 rgb(44,44,46)，与 `.sshrm-card` 的 background 是同一个 token），
      // 不用 `bg-layer-1`（深色下是 rgb(35,35,36)，与卡片不一致会露出色带）。
      // `z-index:1` 让表头压住行（行没有定位，不参与层级竞争）。
      '.sshrm-assetTable .sshrm-gridHead{position:sticky;top:0;z-index:1;background:var(--dsw-alias-settings-card-fill)}',
      '.sshrm-gridRow{border-top:.5px solid var(--dsw-alias-border-l2);height:40px}',
      '.sshrm-gridHead + .sshrm-gridRow{border-top:0}',
      // 整行可点（用户 2026-11-16「checkbox 应该是这一行点击都能操作」）：只有可勾的行才带
      // `sshrm-gridRowPick`，指针与 hover 底色都沿用现有那套语言（与 `.sshrm-iconButton:hover` 同一个 token），
      // 不加动画/过渡；不可勾的行没有这个类，观感与原来一致。
      '.sshrm-gridRowPick{cursor:pointer}',
      '.sshrm-gridRowPick:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      // 状态列 50px ≥ 「已连接」三个 13px 汉字 39px；账号列 64px ≥ `example` 的 7×12×0.602 ≈ 50.6px；
      // 操作列 84px 恰好是三个两字按钮 3×2×14px（刚好、零余量）。列宽都在模板里，这里只留说明。
      '.sshrm-noteRow{padding:0 0 6px;font-size:12px;line-height:18px;white-space:normal}',
      // 操作列不裁：二次确认那一行有三个按钮，宁可溢出两个像素，也不能把「确定」切掉。
      // 这一条排在 `.sshrm-gridCell` 之后，所以它的 `overflow:visible` 压过单元格的兜底裁剪。
      // 单元格自己是 flex 容器（用户 2026-11-16「sshrm-actions 怎么不是满宽？导致按钮挤在一起」）：
      // 里面那个 `.sshrm-actions` 显式 `flex:1 1 auto;width:100%` 才铺满 84px 轨道，
      // `space-between` 才有东西可摊——列宽 84px 是用户实测值，不动。
      '.sshrm-cellActions{display:flex;align-items:center;overflow:visible}',
      '.sshrm-address{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;letter-spacing:-.01em}',
      '.sshrm-account{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}',
      // 备注：单行 + ellipsis。列宽由 grid 模板给出，单元格的 `overflow:hidden` 兜底，
      // 内部的 span 自己再截一次，`title` 上挂全文（见 HostRow）。
      '.sshrm-labelView{display:flex;align-items:center;gap:4px;min-width:0}',
      '.sshrm-labelText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      // 行内编辑框：单元格已经不是 table cell，`100%` 直接对应内容盒，
      // `box-sizing:border-box` 把边框与内边距算进这 100%——不需要任何补偿，也就没有
      // 原来那个 `min-width:120px`（它让输入框比格子内容区宽，被格子剪成半截）。
      '.sshrm-inlineInput{box-sizing:border-box;width:100%;min-width:0;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);padding:2px 6px;outline:none}',
      '.sshrm-inlineInput:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.sshrm-iconButton{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}',
      '.sshrm-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.sshrm-iconButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.sshrm-iconButton:disabled{opacity:.4;cursor:default}',
      '.sshrm-statusOn{color:var(--dsw-alias-state-success-primary)}',
      '.sshrm-statusOff{color:var(--dsw-alias-label-tertiary)}',
      '.sshrm-muted{color:var(--dsw-alias-label-tertiary)}',
      // 操作列：三个两字按钮一字排开；按钮的默认内边距正是装不下的原因，所以按钮一律
      // `padding:0`（连内层图标间距一起归零），三个动作只用 space-between 摊开、不再加 gap。
      // 列宽 84px 由用户实机量出（原 104px 太宽、80px 又刚好差 4px，见 D-46 第十节与第十一节）。
      // 选择器多带一层 `.sshrm-hostsTable`（列表容器类，现在是 div 不是 table）才压得过
      // antd 按钮的默认内边距，不靠 `!important`。
      '.sshrm-hostsTable .sshrm-actions button{padding:0;margin:0;min-width:0;gap:0;white-space:nowrap}',
      // 容器显式占满单元格（用户 2026-11-16「现在是 sshrm-actions 没占满……按钮挤在一起」）：
      // 光靠块级默认宽度撑，单元格一旦不是块级上下文就退化成内容宽，`space-between` 无从摊开；
      // 所以 `flex:1 1 auto;min-width:0;width:100%` 写死，84px 轨道里三个按钮各占一头一尾。
      '.sshrm-actions{display:flex;align-items:center;justify-content:space-between;gap:0;flex-wrap:nowrap;flex:1 1 auto;min-width:0;width:100%}',
      // 二次确认那一行是「删除这台主机？」+ 确认 + 取消，合计约 169px 塞不进 84px；
      // 摊开会把「取消」顶出卡片右边界，所以这一态保持右对齐（溢出仍靠 overflow:visible 可见）。
      '.sshrm-actionsAsk{justify-content:flex-end}',
      '.sshrm-confirmText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-right:2px;white-space:nowrap}',
      '.sshrm-danger{color:var(--dsw-alias-state-error-primary)}',
      '.sshrm-fields{display:grid;grid-template-columns:minmax(0,2fr) minmax(96px,1fr);gap:10px 12px;width:100%}',
      '.sshrm-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.sshrm-fieldWide{grid-column:1/-1}',
      '.sshrm-fieldLabel{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.sshrm-formError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.sshrm-formHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}',
      '.sshrm-formActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.sshrm-inlineNote{font-size:12px;line-height:18px;white-space:pre-line}',
      '.sshrm-noteOk{color:var(--dsw-alias-state-success-primary)}',
      '.sshrm-noteWarn{color:var(--dsw-alias-state-warn-label)}',
      '.sshrm-noteError{color:var(--dsw-alias-state-error-primary)}',
      '.sshrm-assets{display:flex;flex-direction:column;gap:10px;padding-top:2px}',
      // 勾选列：宽度由模板里的 `28px` 给出（14px 复选框 + 12px 间距 + 2px 余量），单元格零内边距，
      // 复选框在这 28px 轨道里**水平居中**（用户 2026-11-16「另外 复选框贴左 改为居中」）。
      // 居中用 flex 而不是给单元格补内缩：刚在第十一节把单元格 padding 全删了，不再开例外，
      // 28px 的余量也只有 2px，内缩必然挤压 14px 复选框本身。
      '.sshrm-assetTable .sshrm-gridCell:first-child{display:flex;align-items:center;justify-content:center}',
      '.sshrm-check{margin:0;accent-color:var(--dsw-alias-state-business-primary);width:14px;height:14px;cursor:pointer}',
      '.sshrm-check:disabled{cursor:default;opacity:.45}',
      '.sshrm-errorBar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}',
      '.sshrm-errorText{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}',
      '.sshrm-skeleton{display:flex;flex-direction:column;gap:10px;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}',
      '.sshrm-skeletonBar{height:14px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);animation:sshrm-pulse 1.4s ease-in-out infinite}',
      '.sshrm-skeletonBar:nth-child(3){width:72%}',
      '.sshrm-skeletonBar:nth-child(4){width:46%}',
      '.sshrm-srOnly{clip:rect(0 0 0 0);width:1px;height:1px;position:absolute;overflow:hidden;white-space:nowrap}',
      '@keyframes sshrm-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '@media (prefers-reduced-motion: reduce){.sshrm-skeletonBar{animation:none}}',
      '@media (max-width: 560px){.sshrm-fields{grid-template-columns:minmax(0,1fr)}}',
    ].join('\n')

    // ═══════════════════════════════════════════════════════════════════
    // 5. 注册
    // ═══════════════════════════════════════════════════════════════════
    exports.inject = ['slots', 'locale']
    exports.apply = (ctx) => {
      ctx.effect(() => mountStyle(CARD_CSS_TAG, CARD_CSS), 'ssh-remote: approval card css')
      ctx.effect(() => mountStyle(SETTINGS_CSS_TAG, SETTINGS_CSS), 'ssh-remote: settings page css')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ssh-remote: settings dictionaries')

      // 左栏导航项的文字随语言切换：宿主在语言变化时重读每个注册项的 `label()`
      // （settings 页订阅了 slot 版本），所以这里给函数而不是字符串。
      const t = ctx.locale.bind(NS)
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT.name, () =>
            ctx.slots.register(
              {
                name: SLOT.name,
                id: SLOT.id,
                order: SLOT.order,
                label: () => t('nav'),
                locale: NS,
              },
              SettingsTab,
            ),
          ),
        'ssh-remote: settings section',
      )
    }

    // 给测试与排查用的常量与组件：加载器只认 apply / inject，其余导出不影响运行。
    // （宿主侧 `index.js` 同样导出 `renderHostsSection` 给单测，理由一样：断言要能
    // 直接读结构，而不是靠人眼看界面。）
    exports.NS = NS
    exports.SLOT = SLOT
    exports.API = API
    exports.DICTIONARIES = { zh, en }
    exports.__test = Object.freeze({
      SettingsTab,
      HostsCard,
      GatewaysCard,
      GatewayItem,
      accountRowKey,
      assetAccountCell,
      assetStatusCell,
    })

    return exports
  },
})
