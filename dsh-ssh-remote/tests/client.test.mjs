/**
 * 浏览器半边（`lib/client.js`）的契约、静态与渲染断言。
 *
 * 为什么能这么测：客户端文件只是一段普通脚本 + 一个 factory；组件是纯函数，只依赖
 * `react` 与 `@deepseek-ai/dsh-client-ui-primitives` 两个平台模块。所以可以在 node 里
 * 用假 `window.__ModuleLoader__` 执行它、用假 `ctx` 跑 `apply`，再用一个几十行的
 * 「假渲染器」把组件树摊平成文字与标签名——不需要浏览器，也不需要 jsdom。
 *
 * 守住的东西：
 * - 槽契约（`settings.plugins.tab` / id / order / label）与语言字典的完整性：
 *   错一个，设置页就不出现或整页空白；
 * - 请求只走 `/plugin-data/ssh-remote/api`、全 POST、同源带 cookie、不写死域名：
 *   写死一次，换端口或反向代理就整页失效；
 * - 界面文案里不出现产品名（D-40：产品名只留在内部标记里）；
 * - 渲染结果里主机行不显示 id 与来源：导入主机与直连主机在界面上必须长得一样。
 *
 * 运行：node dsh-ssh-remote/tests/client.test.mjs（或随 `tests/*.test.mjs` 一起跑）
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(CLIENT, 'utf8')

/**
 * 列表容器的列宽模板：`--sshrm-hosts-cols` / `--sshrm-asset-cols` 的值。
 * 抬头行与数据行都只引用这个变量，所以「列宽」在这一处取一次就够（B-46 的单一来源）。
 */
const gridTemplate = (name) => source.match(new RegExp(`--${name}:([^}']+)`))?.[1].trim() ?? ''
/** 模板里的百分比，按出现顺序。 */
const percentsOf = (template) => [...template.matchAll(/(\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]))
/** 把模板切成列 token（`minmax(0, 1fr)` 算一个 token），下标就是列序。 */
const columnsOf = (template) => template.match(/minmax\(0, 1fr\)|[\d.]+%|[\d.]+px/g) ?? []

/** 用户要求：界面与文案里不出现产品名（D-40）。拆开拼，免得断言匹配到自己。 */
const BANNED = [['Jump', 'Server'].join(''), ['J', 'MS'].join(''), ['令', '牌'].join(''), ['堡', '垒', '机'].join('')]

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/**
 * 假 React：`createElement` 只造普通对象，Hooks 返回初值。
 * 组件不会被 React 真正渲染，测试用下面的假渲染器自己摊平。
 */
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/**
 * 假原语：把「谁被渲染、带什么 props」记进 log，再把 children 原样传下去。
 * Input 额外把 `value` 当文字渲染——真实输入框就是这样显示值的，这样
 * 「密钥不回显」才测得出来（值在 props 里，不在文字里就看不见）。
 */
function createPrimitives(log) {
  const passthrough = (name) => (props) => {
    log.push({ name, props: props ?? {} })
    const children = props?.children === undefined ? [] : [props.children]
    if (name === 'Input') children.unshift(String(props?.value ?? ''))
    return { type: 'div', props: props ?? {}, children }
  }
  return {
    Button: passthrough('Button'),
    Input: passthrough('Input'),
    Modal: passthrough('Modal'),
    Tag: passthrough('Tag'),
    IconEditOutlineRegular: passthrough('IconEdit'),
  }
}

/**
 * 装载客户端文件：执行脚本拿到 factory，再用假 require 求值 exports。
 * `require` 只认平台模块表里的两个包；require 别的直接失败（这本身就是一条断言）。
 */
function loadClient() {
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
    },
    document: undefined,
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: CLIENT })
  assert.ok(definition !== undefined, '客户端必须向 window.__ModuleLoader__ 注册')

  const calls = []
  const primitives = createPrimitives(calls)
  const required = []
  const fakeRequire = (id) => {
    required.push(id)
    if (id === 'react') return fakeReact
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`客户端 require 了平台模块表之外的「${id}」`)
  }
  const exported = definition.factory(fakeRequire)
  return { definition, exported, required, calls }
}

/** 假 ctx：记录 effect / locale.register / slots.register，并真的执行注册回调。 */
function createContext() {
  const state = { effects: [], dictionaries: [], injected: [], registered: [] }
  let bound = {}
  const translate = (key, params) => {
    const template = typeof bound[key] === 'string' ? bound[key] : key
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
  }
  const ctx = {
    effect: (fn, label) => {
      state.effects.push(label)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register: (ns, dicts) => {
        state.dictionaries.push({ ns, dicts })
        if (ns === 'sshRemote') bound = dicts.zh
        return () => {}
      },
      bind: () => translate,
    },
    slots: {
      inject: (name, factory) => {
        state.injected.push(name)
        const disposer = factory()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register: (options, component) => {
        state.registered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, state, translate }
}

/**
 * 假渲染器：把组件树摊平成文字、标签名与 aria-label。
 * 函数组件直接调用（Hooks 是假的，初次渲染读到的是初值），原语是 passthrough。
 */
function renderTree(node) {
  const out = { text: '', tags: [], labels: [] }
  const visit = (current) => {
    if (current === null || current === undefined || current === false || current === true) return
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      out.text += String(current)
      return
    }
    if (typeof current !== 'object') return
    const type = current.type
    const props = current.props ?? {}
    if (props.className !== undefined) out.tags.push(`.${String(props.className).split(' ')[0]}`)
    if (props['aria-label'] !== undefined) out.labels.push(String(props['aria-label']))
    if (typeof type === 'symbol') {
      visit(current.children)
      return
    }
    if (typeof type === 'function') {
      const lifted = { ...props, children: current.children.length <= 1 ? current.children[0] : current.children }
      visit(type(lifted))
      return
    }
    if (typeof type === 'string') {
      out.tags.push(type)
      visit(current.children)
    }
  }
  visit(node)
  return out
}

const loaded = loadClient()
const { ctx, state, translate } = createContext()
loaded.exported.apply(ctx)
const t = translate

await test('加载契约：只 require 平台模块表里的 react 与 primitives', () => {
  assert.deepEqual(loaded.required, ['react', '@deepseek-ai/dsh-client-ui-primitives'])
  assert.equal(loaded.definition.id, 'dsh-ssh-remote', 'id 必须是包名，热更新按它认包')
  const { exported } = loaded
  assert.equal(typeof exported.apply, 'function')
  assert.ok(Array.isArray(exported.inject), 'inject 必须是数组')
  assert.deepEqual([...exported.inject].sort(), ['locale', 'slots'])
})

await test('注册：settings.section 的 name / id / order / label 契约（左栏一级页）', () => {
  assert.equal(state.registered.length, 1, '只注册一个槽（一处入口）')
  assert.deepEqual(state.injected, ['settings.section'], '必须等设置面板声明一级页槽后再注册')
  const { options, component } = state.registered[0]
  assert.equal(options.name, 'settings.section', '槽名错了左栏就没有这一项')
  assert.equal(options.id, 'ssh-remote', 'id 是左栏认这一项的身份')
  assert.equal(typeof options.locale, 'string')
  assert.equal(options.locale, loaded.exported.NS, 'locale 命名空间必须与字典注册一致')
  assert.equal(typeof options.order, 'number')
  assert.ok(Number.isFinite(options.order), 'order 必须是有限数字')
  assert.ok(
    typeof options.label === 'string' || typeof options.label === 'function',
    'label 只能是字符串或返回字符串的函数',
  )
  const label = typeof options.label === 'function' ? options.label() : options.label
  assert.equal(typeof label, 'string')
  assert.ok(label.trim().length > 0, '左栏文字不能为空')
  assert.equal(label, 'SSH 主机')
  assert.equal(typeof component, 'function', '第二个参数是组件本身，不是 React 元素')
  // 一处入口：旧的「内置插件」子标签不许留残影。
  assert.equal(source.includes('settings.plugins.tab'), false, '不许再注册内置插件页的子标签')
})

await test('effect：样式与字典都登记了，卸载时能摘掉', () => {
  assert.equal(state.effects.length, 4)
  assert.ok(state.effects.includes('ssh-remote: approval card css'), '审批卡样式不能被删')
  assert.ok(state.effects.includes('ssh-remote: settings page css'))
  assert.ok(state.effects.includes('ssh-remote: settings dictionaries'))
  assert.ok(state.effects.includes('ssh-remote: settings section'))
})

await test('文案字典：zh / en 键集合一致、值非空、占位符一致', () => {
  assert.equal(state.dictionaries.length, 1)
  const { ns, dicts } = state.dictionaries[0]
  assert.equal(ns, 'sshRemote')
  const zh = dicts.zh
  const en = dicts.en
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '两种语言的键必须一一对应')
  assert.ok(Object.keys(zh).length >= 60, `文案键只有 ${Object.keys(zh).length} 个：少了一大片界面文字`)
  for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
    assert.equal(typeof value, 'string', `「${key}」必须是字符串`)
    assert.ok(value.trim().length > 0, `「${key}」不能是空串`)
  }
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  for (const key of Object.keys(zh)) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `「${key}」两种语言的占位符必须一致`)
  }
})

await test("文案：每个 t('key') 的 key 都在字典里", () => {
  const { dicts } = state.dictionaries[0]
  const used = new Set([...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'\)/g)].map((match) => match[1]))
  assert.ok(used.size >= 40, `只扫到 ${used.size} 个文案键，扫描本身可能失效了`)
  const missing = [...used].filter((key) => typeof dicts.zh[key] !== 'string')
  assert.deepEqual(missing, [], `这些 key 没有对应文案：${missing.join('、')}`)
})

await test('文案：源码与字典里都不出现产品名', () => {
  const { dicts } = state.dictionaries[0]
  const haystack = [source, ...Object.values(dicts.zh), ...Object.values(dicts.en)]
  for (const word of BANNED) {
    const hits = haystack.filter((text) => text.includes(word))
    assert.equal(hits.length, 0, `「${word}」不许出现在界面文案或源码里`)
  }
  assert.ok(source.includes('接入点'), '对外只说「接入点」')
})

await test('请求：路径全在维护接口前缀下、方法 POST、同源带 cookie、不写死域名', () => {
  const { prefix, routes, method } = loaded.exported.API
  assert.equal(prefix, '/plugin-data/ssh-remote/api')
  assert.equal(method, 'POST')
  const values = Object.values(routes)
  assert.equal(values.length, 10, '十条路由一条都不能少（主机五条 + 接入点五条）')
  assert.equal(new Set(values).size, 10, '路由不能重复')
  assert.ok(values.includes('gateway/list'), '多接入点：列表接口')
  assert.ok(values.includes('gateway/remove'), '多接入点：删除接口')
  assert.equal(values.includes('gateway/status'), false, '单接入点的 status 接口已删除')
  for (const route of values) {
    assert.match(route, /^(hosts|gateway)\/[a-z]+$/, `路由「${route}」不在前缀下`)
  }
  assert.ok(source.includes("method: 'POST'"), '请求方法必须写死 POST')
  assert.ok(source.includes("credentials: 'same-origin'"), '同源 fetch 才会带上 DSH 的 cookie')
  assert.ok(source.includes('document.baseURI'), '用 baseURI 拼地址，子路径部署才不会跑偏')
  assert.equal(/https?:\/\//.test(source), false, '客户端里不许出现写死的域名或协议')
})

await test('请求：只有一个 fetch 出口，调用点全部走常量路由', () => {
  const fetchCalls = source.match(/\bfetch\(/g) ?? []
  assert.equal(fetchCalls.length, 1, '多一个 fetch 就多一条绕过错误处理的路径')
  const { routes } = loaded.exported.API
  for (const key of Object.keys(routes)) {
    assert.ok(source.includes(`ROUTES.${key}`), `路由常量 ${key} 没有任何调用点`)
  }
  // 源码里出现的每一条「hosts/…」或「gateway/…」字面量都必须是常量表里的值。
  const literals = [...new Set([...source.matchAll(/'((?:hosts|gateway)\/[a-z]+)'/g)].map((match) => match[1]))]
  assert.deepEqual(literals.sort(), Object.values(routes).sort())
})

await test('凭据边界：不碰浏览器存储，不进 document.body，密码框不回显', () => {
  assert.equal(/localStorage|sessionStorage/.test(source), false, '凭据不许落进浏览器存储')
  assert.equal(/document\.body/.test(source), false, '客户端不许改 document.body')
  const passwordInputs = source.match(/type: 'password'/g) ?? []
  assert.equal(passwordInputs.length, 2, '主机密码与接入点密钥都必须是 password 框')
  assert.ok(source.includes("autoComplete: 'new-password'"), '防止浏览器把已存密码填回来')
  assert.ok(source.includes("secret: ''"), '保存接入点后必须清空密钥框')
})

await test('渲染：首屏是加载态，不是空白也不是错误，且页头就是左栏那一项', () => {
  const view = renderTree(loaded.exported.__test.SettingsTab({ t }))
  assert.ok(view.text.includes('加载中…'), '首屏必须让人看见「加载中」')
  assert.ok(view.tags.includes('.sshrm-section'))
  assert.ok(view.tags.includes('.sshrm-pageTitle'), '一级页要有页头（与左栏同名）')
  assert.ok(view.text.includes('SSH 主机'), '页头文字与左栏导航一致')
  // 列表容器是 `div.sshrm-hostsTable`（Grid），不是 table；数据没回来时一个都不该画。
  assert.equal(view.tags.includes('.sshrm-hostsTable'), false, '数据没回来之前不要先画一张空列表')
  assert.equal(view.tags.includes('.sshrm-assetTable'), false, '资产列表同理')
  assert.equal(view.tags.includes('table'), false, 'DOM 里不再有 table')
})

await test('渲染：主机行只显示地址:端口 / 账号 / 备注 / 状态，不显示来源与 id', () => {
  const callsBefore = loaded.calls.filter((entry) => entry.name === 'Button').length
  const view = renderTree(
    loaded.exported.__test.HostsCard({
      t,
      hosts: [
        {
          id: 'host-abc-123',
          address: '192.168.1.11',
          port: 2222,
          user: 'root',
          label: 'Web 1',
          tags: [],
          source: 'gateway',
          connected: true,
        },
      ],
      onChanged: () => {},
      onRemoved: () => {},
    }),
  )
  // 列表介质：容器是 div.sshrm-hostsTable，抬头行 + 每行一个 `.sshrm-grid`，单元格统一 `.sshrm-gridCell`。
  // （假渲染器只记第一个类名，所以抬头/数据行都落在 `.sshrm-grid` 上，靠条数区分。）
  assert.ok(view.tags.includes('.sshrm-hostsTable'), '有主机时必须画出主机列表容器')
  assert.equal(view.tags.filter((tag) => tag === '.sshrm-grid').length, 2, '抬头行 + 一台主机一行，各一个 grid 容器')
  assert.equal(view.tags.filter((tag) => tag === '.sshrm-gridCell').length, 10, '抬头 5 格 + 数据 5 格')
  assert.equal(view.tags.includes('table'), false, '不是 table')
  assert.equal(view.tags.includes('tr'), false, '也不是 tr')
  assert.equal(view.tags.includes('td'), false, '也不是 td')
  assert.ok(view.text.includes('192.168.1.11:2222'), '地址:端口 要完整显示（端口不能省）')
  assert.ok(view.text.includes('root'))
  assert.ok(view.text.includes('Web 1'))
  assert.ok(view.text.includes('已连接'))
  assert.equal(view.text.includes('host-abc-123'), false, '行里不许出现 id')
  assert.equal(view.text.includes('gateway'), false, '行里不许出现来源标记')
  assert.equal(view.text.includes('direct'), false, '行里不许出现来源标记')
  assert.ok(view.labels.includes('编辑备注'), '备注格的笔图标要有可读名字')
  // 编辑 / 测试 / 删除 + 顶部新增 = 4 个按钮
  assert.equal(loaded.calls.filter((entry) => entry.name === 'Button').length - callsBefore, 4)
})

await test('渲染：空列表给一句说明 + 新增入口', () => {
  const view = renderTree(loaded.exported.__test.HostsCard({ t, hosts: [], onChanged: () => {}, onRemoved: () => {} }))
  assert.ok(view.text.includes('还没有主机'))
  assert.ok(view.text.includes('新增主机'))
  assert.equal(view.tags.includes('.sshrm-hostsTable'), false, '空列表不画抬头与列表容器')
})

await test('渲染：没有接入点时是空态 + 新增入口，不画资产表', () => {
  const callsBefore = loaded.calls.filter((entry) => entry.name === 'Button').length
  const view = renderTree(
    loaded.exported.__test.GatewaysCard({
      t,
      gateways: [],
      onSaved: () => {},
      onRemoved: () => {},
      onHostsChanged: async () => {},
    }),
  )
  assert.ok(view.text.includes('还没有接入点'))
  assert.ok(view.text.includes('新增接入点'))
  assert.equal(view.tags.includes('.sshrm-assetTable'), false, '没拉过资产就不该有资产列表')
  assert.equal(view.tags.includes('.sshrm-hostsTable'), false, '这张卡里也不该出现主机列表')
  // 只有「新增接入点」一个按钮
  assert.equal(loaded.calls.filter((entry) => entry.name === 'Button').length - callsBefore, 1)
})

await test('渲染：每个接入点一张卡，标题用名称、未配置标记与字段各自独立', () => {
  const view = renderTree(
    loaded.exported.__test.GatewaysCard({
      t,
      gateways: [
        { id: 'default', label: '默认', address: '192.168.1.18', appid: 'app-1', port: 2222, hasSecret: true, configured: true },
        { id: '192-168-1-8', label: '测试环境', address: '192.168.1.8', appid: '', port: 52222, hasSecret: false, configured: false },
      ],
      onSaved: () => {},
      onRemoved: () => {},
      onHostsChanged: async () => {},
    }),
  )
  assert.equal(view.tags.filter((tag) => tag === '.sshrm-gateway').length, 2, '两个接入点就是两张卡')
  assert.ok(view.text.includes('默认'), '卡片标题用名称')
  assert.ok(view.text.includes('测试环境'))
  assert.ok(view.text.includes('192.168.1.18'), '地址是配置项，要能看见')
  assert.ok(view.text.includes('192.168.1.8'))
  assert.ok(view.text.includes('52222'), '端口各自独立')
  assert.ok(view.text.includes('未配置'), '没配密钥的那个标「未配置」')
  assert.ok(view.text.includes('已配置'))
  // 每个接入点都有自己的一套动作：已配置的 保存/拉取/删除，未配置的 保存/拉取/删除
  assert.ok(view.text.includes('拉取资产'))
})

await test('渲染：已配置接入点时多出「拉取资产」入口，且不回显密钥', () => {
  const mark = loaded.calls.length
  const view = renderTree(
    loaded.exported.__test.GatewayItem({
      t,
      gateway: { id: 'default', label: '默认', configured: true, address: 'https://gw.example', appid: 'app-1', port: 2222, hasSecret: true },
      onSaved: () => {},
      onRemoved: () => {},
      onHostsChanged: async () => {},
      onCancel: () => {},
    }),
  )
  const rendered = loaded.calls.slice(mark)
  assert.ok(view.text.includes('已配置'))
  assert.ok(view.text.includes('拉取资产'))
  assert.ok(view.text.includes('app-1'), 'appid 是配置项，要能看见')
  assert.ok(view.text.includes('https://gw.example'), '地址是配置项，要能看见')
  // 唯一一个密码框必须是空的：密钥从不进浏览器，页面自然无从回显。
  const secrets = rendered.filter((entry) => entry.name === 'Input' && entry.props.type === 'password')
  assert.equal(secrets.length, 1, '接入点只有一个密钥框')
  assert.equal(secrets[0].props.value, '', '密钥框的值必须始终为空')
  assert.equal(rendered.filter((entry) => entry.name === 'Button').length, 3, '保存 + 拉取资产 + 删除')
})

await test('请求：每张接入点卡的拉取 / 导入 / 删除都带自己的 gatewayId', () => {
  assert.ok(source.includes('ROUTES.gatewayAssets, { gatewayId: gateway.id }'), '拉资产按接入点')
  assert.ok(source.includes('callApi(ROUTES.gatewayImport, { gatewayId: gateway.id, items })'), '导入按接入点，提交的是「资产 + 账号」')
  assert.ok(source.includes('{ assetId: String(row.assetId), account: String(row.account.alias) }'), '一个账号一项，带别名')
  assert.ok(source.includes('ROUTES.gatewayRemove, { id: gateway.id }'), '删除按接入点')
  assert.ok(source.includes('ROUTES.gatewayList'), '首屏拉接入点列表')
  // 一个接入点一张卡：卡片数据属性带上 id，测试与排查能对上号。
  assert.ok(source.includes("'data-ssh-remote-gateway': editing ? gateway.id : 'new'"))
})

await test('样式：铺满可用宽度、Grid 列宽一次定死、单元格不折行、备注单行省略', () => {
  assert.equal(/\.sshrm-section\{[^}]*max-width/.test(source), false, '页面自己不许设宽度上限，外壳给多少用多少')
  assert.ok(source.includes('width:100%;min-width:0'), '铺满父容器')

  // 介质：两张列表都是 grid，不再是 table；列宽模板只定义在列表容器上，
  // 抬头行与数据行都 `grid-template-columns:var(--sshrm-…)`，让断言能查到这一个来源。
  assert.ok(source.includes("'.sshrm-grid{display:grid;align-items:center;min-width:0}'"), '列表行是 grid 容器')
  assert.ok(source.includes("'.sshrm-hostsTable{--sshrm-hosts-cols:"), '主机表列宽模板定义在容器上')
  assert.ok(source.includes("'.sshrm-assetTable{--sshrm-asset-cols:"), '资产表列宽模板定义在容器上')
  assert.ok(
    source.includes('.sshrm-hostsTable .sshrm-grid{grid-template-columns:var(--sshrm-hosts-cols)}'),
    '主机表抬头行与数据行共用同一个模板变量',
  )
  assert.ok(
    source.includes('.sshrm-assetTable .sshrm-grid{grid-template-columns:var(--sshrm-asset-cols)}'),
    '资产表抬头行与数据行共用同一个模板变量',
  )
  assert.equal((source.match(/--sshrm-hosts-cols:/g) ?? []).length, 1, '主机表列宽只定义一处')
  assert.equal((source.match(/var\(--sshrm-hosts-cols\)/g) ?? []).length, 1, '主机表抬头行与数据行共用这一处定义')
  assert.equal((source.match(/--sshrm-asset-cols:/g) ?? []).length, 1, '资产表列宽只定义一处')
  assert.equal((source.match(/var\(--sshrm-asset-cols\)/g) ?? []).length, 1, '资产表抬头行与数据行共用这一处定义')

  // 单元格统一一个类：不折行、省略号、可压缩、按 border-box 算（B-46）。
  const cellRule = source.match(/\.sshrm-gridCell\{[^}]*\}/)?.[0] ?? ''
  assert.ok(cellRule.includes('white-space:nowrap'), '单元格内容不折行')
  assert.ok(cellRule.includes('text-overflow:ellipsis'), '超长文字省略')
  assert.ok(cellRule.includes('overflow:hidden'), '溢出兜底裁剪（不再是唯一手段）')
  assert.ok(cellRule.includes('min-width:0'), '单元格可压缩，不会把轨道撑破')
  assert.ok(cellRule.includes('box-sizing:border-box'), '单元格按 border-box 算（B-46）')
  // 用户 2026-11-16：「左右不用 padding 可以移除单元格 padding」「直接用行高 40 就行了」「hight: 40px」。
  // 节奏不再由单元格内边距给：单元格零 padding，高度由行容器的 `height` 给出。
  assert.equal(/\bpadding\b/.test(cellRule), false, '单元格规则里不许再有任何 padding（轨道宽 = 内容可用宽）')
  const headRule = source.match(/\.sshrm-gridHead\{[^}]*\}/)?.[0] ?? ''
  assert.ok(headRule.includes('height:28px'), '抬头行高度由行容器的 height 给出（28px）')
  assert.ok(headRule.includes('padding-bottom:6px'), '抬头行留 6px 下内边距保持与数据行的呼吸')
  const rowRule = source.match(/\.sshrm-gridRow\{[^}]*\}/)?.[0] ?? ''
  assert.ok(rowRule.includes('height:40px'), '数据行行高固定 40px（用 height，不靠内边距撑）')
  // 反向断言：靠单元格给节奏的残留一律不许再出现（老的表头/数据格 padding 与末列 padding-right:0）。
  for (const leftover of ['8px 12px 8px 0', '0 12px 6px 0', 'padding-right:0']) {
    assert.equal(source.includes(leftover), false, `单元格内边距残留「${leftover}」已清除`)
  }
  assert.equal(
    /\.sshrm-(?:gridHead|gridRow) \.sshrm-gridCell\{/.test(source),
    false,
    '不再有「靠单元格给节奏」的 .sshrm-gridHead/.sshrm-gridRow 后裔单元格规则',
  )
  // 分隔线画在行容器的**上界**：提示行 `.sshrm-noteRow` 是行容器的兄弟节点，
  // 「最后一行」不一定是最后一个子元素，所以这里不能用 `:last-child` 收尾。
  assert.ok(
    rowRule.includes('border-top:.5px solid var(--dsw-alias-border-l2)'),
    '行分隔线画在行容器上界（连续、不随各格高度断开）',
  )
  assert.ok(source.includes('.sshrm-gridHead + .sshrm-gridRow{border-top:0}'), '抬头行紧接的第一行不重复画线')
  assert.equal(
    source.includes('.sshrm-gridRow:last-child'),
    false,
    '不许用 :last-child 给最后一行收尾——最后一行带提示时它不成立',
  )

  // 勾选列的复选框居中（用户 2026-11-16「另外 复选框贴左 改为居中」）：在 28px 轨道里用 flex 居中，
  // 不给单元格补内缩——第十一节刚把单元格 padding 全删掉，不再开例外。
  const checkCellRule = source.match(/\.sshrm-assetTable \.sshrm-gridCell:first-child\{[^}]*\}/)?.[0] ?? ''
  assert.ok(checkCellRule.includes('display:flex'), '勾选格用 flex 居中（不是靠 padding）')
  assert.ok(checkCellRule.includes('align-items:center'), '勾选格垂直居中')
  assert.ok(checkCellRule.includes('justify-content:center'), '复选框在 28px 轨道里水平居中（不再贴左）')
  assert.equal(/\bpadding\b/.test(checkCellRule), false, '居中不靠 padding（单元格零内边距不开例外）')

  assert.ok(/\.sshrm-labelText\{[^}]*text-overflow:ellipsis/.test(source), '备注单行 + 省略')
  assert.ok(/\.sshrm-actions\{[^}]*flex-wrap:nowrap/.test(source), '操作按钮不换行')
  assert.ok(/\.sshrm-address\{[^}]*--ds-font-family-code/.test(source), '地址与端口用等宽字体')
  assert.ok(source.includes('.sshrm-hostsTable .sshrm-actions button'), '按钮零内边距的规则仍挂在主机列表容器上')
  assert.ok(source.includes("title: hostNote(host)"), '备注要有 title 显示全文')
  assert.ok(source.includes("title: `${host.address}:${host.port}`"), '地址被省略时也能看全文')

  // 备注的行内编辑框：单元格不是 table cell 了，`100%` 直接对应内容盒，
  // `border-box` 把边框与内边距算进去，所以原来那个 `min-width:120px` 必须删掉。
  const inlineRule = source.match(/\.sshrm-inlineInput\{[^}]*\}/)?.[0] ?? ''
  assert.ok(inlineRule.includes('box-sizing:border-box'), '输入框按 border-box 算宽度')
  assert.ok(inlineRule.includes('width:100%'), '输入框铺满单元格内容盒')
  assert.ok(inlineRule.includes('min-width:0'), '输入框可以跟着列宽一起缩')
  assert.equal(inlineRule.includes('min-width:120px'), false, 'table 时代为补偿列宽写的 min-width:120px 已删除')

  // 提示行是紧随其后的一整块，不再靠 colspan 跨列。
  assert.match(source, /h\(\s*'div',\s*\{ className: 'sshrm-noteRow' \}/, '提示行是独立块')
  assert.equal(source.includes('colSpan'), false, '不再用 colspan 跨列')
})

await test('列宽：两表都按像素、同类列同宽——主机表 128/64 + 备注吃剩余 + 50/84px，资产表 28px + 名称吃剩余 + 128/64/50px，且不许出现 calc', () => {
  // 用户 2026-11-16 在自己的环境里实机量出的宽度，整组替换掉原来的「百分比 + 80px」：
  // 地址:端口 128px / 账号 64px / 备注 minmax(0, 1fr) / 状态 50px / 操作 84px。
  // 单元格零内边距（见第 17 条），所以每个轨道宽就是该列内容可用的宽度。
  const hosts = gridTemplate('sshrm-hosts-cols')
  assert.equal(
    hosts,
    '128px 64px minmax(0, 1fr) 50px 84px',
    '主机表五列：地址:端口 128px / 账号 64px / 备注 minmax(0, 1fr) / 状态 50px / 操作 84px',
  )
  // 逐位核对列序与轨道类型：两个 px + 1fr + 两个 px，不能再有百分比（用户给的是实测像素）。
  assert.deepEqual(
    columnsOf(hosts),
    ['128px', '64px', 'minmax(0, 1fr)', '50px', '84px'],
    '五列逐位依次是 128px / 64px / minmax(0, 1fr) / 50px / 84px',
  )
  assert.equal((hosts.match(/minmax\(0, 1fr\)/g) ?? []).length, 1, '只有备注列吃掉剩余宽度')
  assert.deepEqual(percentsOf(hosts), [], '主机表不再有百分比列')
  assert.ok(hosts.endsWith('84px'), '操作列固定 84px（用户实测值，三个两字按钮刚好）')
  // 卡片内容区按 532px（564 减两侧各 16px）算：四个固定轨道 128+64+50+84 = 326px，
  // 备注列还剩约 206px，不会挤成 0 或溢出。
  const fixedTotal = columnsOf(hosts)
    .filter((token) => token.endsWith('px'))
    .reduce((sum, token) => sum + Number(token.replace('px', '')), 0)
  assert.equal(fixedTotal, 128 + 64 + 50 + 84, '四个固定轨道合计 326px')
  const noteWidthPx = 532 - fixedTotal
  assert.ok(noteWidthPx > 0, `备注列在 532px 里还剩 ${noteWidthPx.toFixed(1)}px`)

  // 资产表同样改成像素（用户 2026-11-16「下面也应该改为像素啊」「原因是本来设置页就是固定宽度的」
  // 「直接用像素即可」「保持统一」）：勾选 28px / 名称吃剩余 / 地址:端口 128px / 账号 64px / 状态 50px——
  // 地址、账号、状态三列与主机表取同一个数（同类列同宽），勾选列照旧 28px（14px 复选框 + 12px 间距 + 2px 余量），
  // 名称列照旧吃剩余。单元格零内边距（见第 17 条），所以轨道宽就是内容可用宽。
  const assets = gridTemplate('sshrm-asset-cols')
  assert.equal(
    assets,
    '28px minmax(0, 1fr) 128px 64px 50px',
    '资产表五列：勾选 28px / 名称 minmax(0, 1fr) / 地址:端口 128px / 账号 64px / 状态 50px',
  )
  assert.deepEqual(
    columnsOf(assets),
    ['28px', 'minmax(0, 1fr)', '128px', '64px', '50px'],
    '五列逐位依次是 28px / minmax(0, 1fr) / 128px / 64px / 50px',
  )
  assert.equal((assets.match(/minmax\(0, 1fr\)/g) ?? []).length, 1, '名称列吃剩余宽度')
  assert.deepEqual(percentsOf(assets), [], '资产表不再有百分比列')
  // 四个固定轨道合计 28 + 128 + 64 + 50 = 270px，名称列在 532px 里还剩 262px。
  const assetFixedTotal = columnsOf(assets)
    .filter((token) => token.endsWith('px'))
    .reduce((sum, token) => sum + Number(token.replace('px', '')), 0)
  assert.equal(assetFixedTotal, 28 + 128 + 64 + 50, '四个固定轨道合计 270px')
  const assetNamePx = 532 - assetFixedTotal
  assert.ok(assetNamePx > 0, `名称列在 532px 里还剩 ${assetNamePx.toFixed(1)}px`)

  // 反向断言：设置页本来就是固定宽度，模板里再出现 `%` 只会让「量出来的宽度」与实际渲染脱节。
  assert.equal(/%/.test(hosts), false, '主机表模板里不许出现百分比')
  assert.equal(/%/.test(assets), false, '资产表模板里不许出现百分比')

  // 反向断言：列宽不许再写成 calc(...)（`calc((100% - 28px) * .58)` 会被 Chromium 整条丢弃），
  // 也不许留 auto（自动分配正是「宽度还是有问题」的来源）。
  assert.equal(/calc\(/.test(hosts) || /calc\(/.test(assets), false, '列宽不许用 calc')
  assert.equal(/--sshrm-(hosts|asset)-cols:[^}]*auto/.test(source), false, '列宽不许留 auto')
})

await test('操作列：单元格 flex + 容器满宽，按钮 padding 归零，三个动作 space-between 摊开、不加 gap', () => {
  // 用户 2026-11-16「sshrm-actions 怎么不是满宽？导致按钮挤在一起」：单元格先变成 flex 容器，
  // 里面的 `.sshrm-actions` 再显式 `flex:1 1 auto;width:100%` 铺满 84px 轨道，`space-between` 才有东西可摊。
  const cellActions = source.match(/\.sshrm-cellActions\{[^}]*\}/)?.[0] ?? ''
  assert.ok(cellActions.includes('display:flex'), '操作列单元格是 flex 容器（不是靠块级默认宽度）')
  assert.ok(cellActions.includes('align-items:center'), '操作列垂直居中')
  assert.ok(cellActions.includes('overflow:visible'), '二次确认态仍然允许溢出显示')

  const actions = source.match(/\.sshrm-actions\{[^}]*\}/)?.[0] ?? ''
  assert.ok(actions.includes('justify-content:space-between'), '三个动作均分整列宽度')
  assert.ok(actions.includes('width:100%'), '动作容器占满单元格（84px 轨道）')
  assert.ok(actions.includes('flex:1 1 auto'), '单元格是 flex 时也撑满可用宽度')
  assert.ok(actions.includes('min-width:0'), '撑满的同时允许收缩，按钮不被顶出轨道')
  assert.equal(actions.includes('justify-content:flex-end'), false, '不再挤在右边')
  assert.equal(/gap:\s*(?:[1-9]|\d+px)/.test(actions), false, '按钮之间不留额外 gap（只靠 space-between）')

  const button = source.match(/\.sshrm-hostsTable \.sshrm-actions button\{[^}]*\}/)?.[0] ?? ''
  assert.ok(button.includes('padding:0'), 'antd 按钮的默认内边距一律去掉，否则 16% 装不下三个词')
  assert.ok(button.includes('gap:0'), '图标与文字的间距也归零')
  assert.ok(button.includes('white-space:nowrap'), '按钮文字不折行')

  // 二次确认态是「一句话 + 确认 + 取消」，摊不开：单独右对齐，但按钮照样零内边距。
  assert.ok(source.includes('.sshrm-actionsAsk{justify-content:flex-end}'), '二次确认不跟着摊开')
  assert.ok(source.includes("cx('sshrm-actions', confirming ? 'sshrm-actionsAsk' : undefined)"), '两态由 confirming 切换')
})

await test('状态列与账号列：两表同类列同宽——地址 128px、账号 64px ≥ example 的 50.6px，状态 50px ≥ 「已连接」的 39px', () => {
  // 显式 nowrap 从 `.sshrm-hostsTable td:nth-child(2)/(4)` 这类 table 选择器搬到统一的 `.sshrm-gridCell`：
  // 账号与状态两列（两张表）都靠它保证不折行，删了基础规则也不会只坏一列。
  assert.ok(/\.sshrm-gridCell\{[^}]*white-space:nowrap/.test(source), '所有单元格（含账号、状态列）显式 nowrap')
  const hostsCols = columnsOf(gridTemplate('sshrm-hosts-cols'))
  const assetCols = columnsOf(gridTemplate('sshrm-asset-cols'))
  assert.equal(hostsCols[3], '50px', '主机表状态列（第 4 列）是 50px（用户实测值）')
  assert.equal(assetCols[4], '50px', '资产表状态列（第 5 列）也是 50px（与主机表同值）')
  // 像素口径：单元格零内边距，所以轨道宽就是内容可用宽，不用再减掉 12px 右内边距。
  // 状态列 50px ≥「已连接」三个 13px 汉字 39px。
  const hostsStatusPx = Number(hostsCols[3].replace('px', ''))
  const assetStatusPx = Number(assetCols[4].replace('px', ''))
  assert.ok(hostsStatusPx >= 3 * 13, `状态列 ${hostsStatusPx}px 必须 ≥ 「已连接」的 39px`)
  assert.equal(assetStatusPx, hostsStatusPx, '两表状态列数值相等（这就是「保持统一」的载体）')
  // 账号列 64px：`example` 是 7 个等宽字符，12px 下按常见等宽字体最宽的 0.602em 算
  // 也只有 7×12×0.602 ≈ 50.6px —— 放得下。
  const hostsAccountPx = Number(hostsCols[1].replace('px', ''))
  const assetAccountPx = Number(assetCols[3].replace('px', ''))
  const examplePx = 7 * 12 * 0.602
  assert.ok(hostsAccountPx >= examplePx, `主机表账号列 ${hostsAccountPx}px 必须 ≥ example 的 ${examplePx.toFixed(1)}px`)
  assert.ok(assetAccountPx >= examplePx, `资产表账号列 ${assetAccountPx}px 必须 ≥ example 的 ${examplePx.toFixed(1)}px`)
  assert.equal(assetAccountPx, hostsAccountPx, '两表账号列数值相等（这就是「保持统一」的载体）')
  // 地址:端口列两表也同值 128px（`192.168.1.13:2222` 这类长地址要放得下）。
  const hostsEndpointPx = Number(hostsCols[0].replace('px', ''))
  const assetEndpointPx = Number(assetCols[2].replace('px', ''))
  assert.equal(assetEndpointPx, 128, '地址:端口列 128px（用户实测值）')
  assert.equal(assetEndpointPx, hostsEndpointPx, '两表地址:端口列数值相等')
  // 操作列 84px = 三个两字按钮 3 × 2 × 14px，**刚好、零余量**：用户给的就是这个数，
  // 它既与实测一致、也是「三个按钮一个不多一个不少」的算术结果。
  const hostsActionsPx = Number(hostsCols[4].replace('px', ''))
  assert.equal(hostsActionsPx, 3 * 2 * 14, '操作列 84px 恰好等于三个两字按钮的总宽（刚好、零余量）')
})

await test('资产表：一个账号一行（列是勾选/名称/地址/账号/状态），行键按账号区分', () => {
  // 列顺序：一台资产两个账号也是这张列表，账号列必须存在，否则两行看起来一模一样。
  const assetStart = source.indexOf("className: 'sshrm-assetTable'")
  assert.ok(assetStart > 0, '资产列表容器要在源码里')
  const header = source.slice(assetStart, assetStart + 900)
  assert.ok(header.includes("sshrm-grid sshrm-gridHead"), '资产列表用 grid 抬头行')
  for (const key of ['colName', 'colEndpoint', 'colAccount', 'colImported']) {
    assert.ok(header.includes(`t('${key}')`), `资产列表要有「${key}」这一列`)
  }
  const order = ['colName', 'colEndpoint', 'colAccount', 'colImported'].map((key) => header.indexOf(`t('${key}')`))
  assert.deepEqual([...order].sort((a, b) => a - b), order, '列顺序是 名称 → 地址 → 账号 → 状态')

  // 一个账号一行：行里读 assetId + account，靠 rowKey 记勾选，不再按资产 id。
  assert.ok(source.includes('row.assetId'), '行数据来自 gateway/assets 的账号行')
  assert.ok(source.includes("t('noAccount')"), '没有可用账号的行要写明，而不是留空')
  assert.ok(source.includes("className: 'sshrm-account'"), '账号列用自己的样式（等宽）')
  assert.ok(source.includes('disabled: imported || account === null || busy !== null'), '已导入 / 无账号的行不许勾')

  // 行键语义：同一台资产的两个账号是两行，重复拉取时同一账号仍是同一个键。
  const { accountRowKey } = loaded.exported.__test
  assert.equal(accountRowKey({ assetId: '7', account: { alias: 'example' } }), '7|example')
  assert.notEqual(accountRowKey({ assetId: '7', account: { alias: 'root' } }), '7|example')
  assert.notEqual(accountRowKey({ assetId: '7', account: { alias: 'root' } }), accountRowKey({ assetId: '8', account: { alias: 'root' } }))
  assert.equal(accountRowKey({ assetId: '9', account: null }), '9|', '没有账号的行也有稳定的键')
  assert.equal(
    accountRowKey({ assetId: '7', account: { alias: 'root' } }),
    accountRowKey({ assetId: '7', account: { alias: 'root' } }),
    '同一行两次渲染的键必须一致',
  )
})

await test('资产表账号格：只写账号本身，不带括号里的别名/资产名', () => {
  const { assetAccountCell } = loaded.exported.__test
  // 用户 2026-11-15「账号怎么还带有括号里面ip可以只留账号」：别名与用户名不同也只写用户名。
  const cell = assetAccountCell(t, { alias: 'root-prod', username: 'root' })
  const view = renderTree(cell)
  assert.equal(view.text, 'root', '账号格的文字就是 username')
  assert.equal(view.text.includes('('), false, '不许出现括号后缀')
  assert.deepEqual(view.tags.filter((tag) => tag.startsWith('.')), ['.sshrm-account'], '账号用等宽样式')
  assert.equal(renderTree(assetAccountCell(t, null)).text, '无可用账号', '没有可用账号的行照旧写明')
  // 旧的 `${username} (${alias})` 拼接已彻底删掉（不是被遮住）。
  assert.equal(source.includes('(${String(account.alias)})'), false, '括号形态从源码里删干净')
  assert.ok(
    source.includes("h('div', { className: 'sshrm-gridCell', title: username }, assetAccountCell(t, account))"),
    '列表用的是这个格子',
  )
})

await test('资产表状态格：与主机表同款纯文本 + 状态色，不用 Tag，两态结构一致', () => {
  const { assetStatusCell } = loaded.exported.__test
  const tagCallsBefore = loaded.calls.filter((entry) => entry.name === 'Tag').length
  const done = assetStatusCell(t, true)
  const notDone = assetStatusCell(t, false)
  assert.equal(loaded.calls.filter((entry) => entry.name === 'Tag').length - tagCallsBefore, 0, '状态格不再渲染 Tag')
  for (const [node, text, className] of [
    [done, '已导入', 'sshrm-statusOn'],
    [notDone, '未导入', 'sshrm-statusOff'],
  ]) {
    assert.equal(node.type, 'span', '两种状态都是 span')
    assert.deepEqual(Object.keys(node.props), ['className'], '结构相同：只有 className 一个 prop')
    assert.equal(node.props.className, className, '颜色走主机表那套 statusOn / statusOff')
    assert.equal(renderTree(node).text, text, '只有文字不同')
  }
  // 与主机表共用同一套状态样式（照抄的那两行），不发明第三种样子。
  assert.ok(source.includes("'.sshrm-statusOn{color:var(--dsw-alias-state-success-primary)}'"))
  assert.ok(source.includes("'.sshrm-statusOff{color:var(--dsw-alias-label-tertiary)}'"))
  assert.equal(source.includes("h(Tag, { tone: 'neutral' }, t('imported'))"), false, '资产表状态不再走 Tag')
  assert.ok(
    source.includes("h('div', { className: 'sshrm-gridCell' }, assetStatusCell(t, imported))"),
    '列表用的是这个格子',
  )
})

await test('布局介质：两张列表里不再有 table 相关标签与规则，列宽只能是 grid 模板', () => {
  // B-46 的落地检查：table 那套（`table-layout` + `th:nth-child(n){width}` + 单元格 padding）
  // 与 grid 模板不能共存，留着任何一条都说明还有一处没改完。
  for (const banned of ['table-layout', '.sshrm-table', 'th:nth-child', '<table', '<thead', '<tbody', '<tr', '<td', '<th']) {
    assert.equal(source.includes(banned), false, `客户端里不许再出现「${banned}」`)
  }
  assert.ok(source.includes('grid-template-columns'), '列宽必须用 grid-template-columns 定')
  assert.ok(source.includes('minmax(0, 1fr)'), '长列用 minmax(0, 1fr) 吃掉剩余宽度')
  assert.ok(source.includes('--sshrm-hosts-cols'), '主机表模板是自定义属性')
  assert.ok(source.includes('--sshrm-asset-cols'), '资产表模板是自定义属性')
  assert.ok(
    source.includes('.sshrm-hostsTable .sshrm-grid{grid-template-columns:var(--sshrm-hosts-cols)}'),
    '主机表抬头行与数据行引用同一个模板',
  )
  assert.ok(
    source.includes('.sshrm-assetTable .sshrm-grid{grid-template-columns:var(--sshrm-asset-cols)}'),
    '资产表抬头行与数据行引用同一个模板',
  )
  // 两张列表的 DOM 里一个 table 系标签都不许有（含缩进差异）。
  assert.equal(/h\('(table|thead|tbody|tr|th|td)'/.test(source), false, '列表的 DOM 里不再有 table / tr / td / th')
})

await test('资产行整行可点：行容器走同一个 toggle、勾选框 stopPropagation、只有可勾行带 pointer 观感', () => {
  // 用户 2026-11-16「checkbox 应该是这一行点击都能操作」：28px 的勾选格之外，整行也要能点。
  // 1) 行容器：`.sshrm-grid sshrm-gridRow` 与 onClick 在同一个 props 对象里，点击落点在行上。
  const rowClassAt = source.indexOf("className: cx('sshrm-grid sshrm-gridRow'")
  assert.ok(rowClassAt > 0, '资产行容器仍用 `sshrm-grid sshrm-gridRow` 两个类（介质不变）')
  const rowWindow = source.slice(rowClassAt, rowClassAt + 700)
  assert.ok(rowWindow.includes("pickable ? 'sshrm-gridRowPick' : undefined"), '可勾行才追加 pointer 类名')
  assert.ok(rowWindow.includes('onClick: () => {'), '行容器对象里有 onClick（整行可点的落点）')
  assert.ok(rowWindow.includes('if (!pickable) return'), '不可勾行点击直接返回：不调 toggle、不报错')
  // 真实签名是 `toggle(key, checked)`（目标状态），所以行点击传的是现算的目标状态，不是「切换」。
  assert.ok(rowWindow.includes('toggle(key, !selected.has(key))'), '行点击按目标状态调 toggle(key, checked)')
  // 2) 不重复切换：勾选框自己 stopPropagation，事件不再冒泡到行容器；onChange 仍是唯一的状态入口。
  const checkAt = source.indexOf("className: 'sshrm-check'")
  assert.ok(checkAt > 0, '勾选框仍在资产行里')
  const checkWindow = source.slice(checkAt, checkAt + 900)
  assert.ok(
    checkWindow.includes('onClick: (event) => event.stopPropagation()'),
    '勾选框 onClick 必须 stopPropagation，否则点一次勾选框会被行点击再切一次',
  )
  assert.ok(
    checkWindow.includes('onChange: (event) => toggle(key, event.target.checked)'),
    '勾选框仍只走 onChange 一次',
  )
  // 3) 可勾判断与 `disabled` 是同一组条件（imported / account === null / busy !== null）。
  assert.ok(
    source.includes('const pickable = imported === false && account !== null && busy === null'),
    '只有「未导入 + 有账号 + 不忙」的行可勾：三个条件都参与判断',
  )
  // 键盘可达性不退化：勾选框是唯一的表单控件，行点击只是附加快捷方式，不新增 role/tabindex。
  assert.equal(source.includes("role: 'checkbox'"), false, '不把行做成 role="checkbox"（勾选框已有原生语义）')
  assert.equal(/tabIndex/.test(source), false, '不给行加 tabindex')

  // 4) CSS：可点观感只用现有 token，不加动画/过渡。
  const pickRule = source.match(/\.sshrm-gridRowPick\{[^}]*\}/)?.[0] ?? ''
  assert.ok(pickRule.includes('cursor:pointer'), '.sshrm-gridRowPick 给可勾行手型指针')
  assert.equal(/transition|animation/.test(pickRule), false, '不加过渡/动画')
  const pickHoverRule = source.match(/\.sshrm-gridRowPick:hover\{[^}]*\}/)?.[0] ?? ''
  assert.ok(pickHoverRule.length > 0, '可勾行要有 hover 规则')
  assert.ok(
    pickHoverRule.includes('background:var(--dsw-alias-interactive-bg-hover)'),
    'hover 底色沿用 --dsw-alias-interactive-bg-hover（与 .sshrm-iconButton:hover 同一套语言）',
  )
  assert.ok(
    source.includes('.sshrm-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)'),
    '同一个 hover token 就是现有按钮语言，不另造颜色',
  )
  // 行高/列宽/勾选居中一律不动：这次只加点击路径与观感，不改布局口径。
  assert.ok(source.includes('.sshrm-gridRow{border-top:.5px solid var(--dsw-alias-border-l2);height:40px}'), '行高仍 40px')
  assert.ok(
    source.includes('.sshrm-assetTable{--sshrm-asset-cols:28px minmax(0, 1fr) 128px 64px 50px}'),
    '资产表列宽模板一字未动',
  )
})

await test('资产列表限高与吸顶表头：列表自己滚、表头贴顶压住行，主机表不限高也不吸顶', () => {
  // 用户 2026-11-16「获取的资产列表 可以给个最高高度」：资产多时列表自己滚，不再把卡片顶长（D-46 第十五节）。
  // 1) 容器限高 + 内部滚动。资产表有两条 `.sshrm-assetTable` 规则（列宽模板一条、盒子一条），
  //    这里按内容找带 `max-height` 的那条，不靠规则顺序。
  const assetRules = [...source.matchAll(/\.sshrm-assetTable\{[^}]*\}/g)].map((match) => match[0])
  const scrollRule = assetRules.find((rule) => rule.includes('max-height')) ?? ''
  assert.ok(scrollRule.includes('max-height:320px'), '资产列表容器限高 320px（表头 34 + 7 行 × 40 = 314，留 6px）')
  assert.ok(scrollRule.includes('overflow-y:auto'), '超出部分在列表内部滚动，不再顶长卡片')
  assert.ok(scrollRule.includes('overflow-x:hidden'), '横向不滚：列宽是像素模板，超出的只有纵向')
  assert.equal((source.match(/max-height:320px/g) ?? []).length, 1, '限高只定义一处：用户以后给数就改这一个数')

  // 2) 表头吸顶：只挂在资产列表（唯一的滚动容器）里的表头上；底色不透明，滚过去的行不会透出来。
  const assetHeadRule = source.match(/\.sshrm-assetTable \.sshrm-gridHead\{[^}]*\}/)?.[0] ?? ''
  assert.ok(assetHeadRule.includes('position:sticky'), '资产表表头 position:sticky（跟着滚动区贴顶）')
  assert.ok(assetHeadRule.includes('top:0'), '吸顶点是滚动区上沿 0')
  assert.ok(
    assetHeadRule.includes('background:var(--dsw-alias-settings-card-fill)'),
    '表头底色用卡片自己的 token（= bg-layer-2，浅/深色都是不透明的卡片底色）',
  )
  assert.equal(/background:\s*(?:transparent|none)/.test(assetHeadRule), false, '底色不能透明——透明就压不住滚过去的行')
  assert.ok(assetHeadRule.includes('z-index:1'), '表头层级高于行（行没有定位，不参与竞争）')

  // 3) 反向断言：主机表是短列表，不限高；它的表头也不吸顶——
  //    无前缀的 `position:sticky` 会相对设置页的滚动容器 `.VOzbGW_options{overflow-y:auto}` 生效，
  //    主机表表头会浮在自己那几行上面。
  const hostsRule = source.match(/\.sshrm-hostsTable\{[^}]*\}/)?.[0] ?? ''
  assert.ok(hostsRule.includes('--sshrm-hosts-cols:'), '主机表容器规则仍在（只放列宽模板）')
  assert.equal(/max-height/.test(hostsRule), false, '主机表不限高（短列表，不跟着资产表一起限高）')
  const baseHeadRule = source.match(/\.sshrm-gridHead\{[^}]*\}/)?.[0] ?? ''
  assert.equal(/position:sticky/.test(baseHeadRule), false, 'sticky 不挂在无前缀的 .sshrm-gridHead 上（否则主机表也吸顶）')

  // 4) 反向断言：滚动交给浏览器原生行为——不自绘滚动条、不加翻页器、不加底部渐隐遮罩。
  assert.equal(source.includes('::-webkit-scrollbar'), false, '不自定义滚动条选择器（宿主主题已统一 5px 皮肤）')
  assert.equal(/scrollbar-(?:width|color|track|thumb)/.test(source), false, '不改滚动条宽度/颜色')
  assert.equal(/linear-gradient/.test(source), false, '不加渐隐遮罩')
  assert.equal(/pagination|Paginator/i.test(source), false, '不加翻页器')

  // 5) 既有口径一字不动：表头 28px + 6px、行高 40px、资产表列宽模板。
  assert.ok(
    source.includes('.sshrm-gridHead{border-bottom:.5px solid var(--dsw-alias-border-l2);height:28px;padding-bottom:6px'),
    '表头仍 28px + 6px 下内边距',
  )
  assert.ok(source.includes('.sshrm-gridRow{border-top:.5px solid var(--dsw-alias-border-l2);height:40px}'), '行高仍 40px')
  assert.ok(
    source.includes('.sshrm-assetTable{--sshrm-asset-cols:28px minmax(0, 1fr) 128px 64px 50px}'),
    '资产表列宽模板一字未动（盒子规则是另一条）',
  )
})

await test('node --check：客户端文件本身是合法脚本', () => {
  const result = spawnSync(process.execPath, ['--check', CLIENT], { stdio: 'ignore' })
  assert.equal(result.status, 0, 'node --check 必须通过（客户端不是 ESM，按脚本检查）')
})

console.log(`\n结果：全部通过（${passed} 项）`)
