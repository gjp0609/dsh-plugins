# 接入点（批量导入主机）自检：不需要 WebView2、不弹窗、不联网、不碰真密码库。
# 跑法：pwsh -NoProfile -File tests/jms.ps1
#
# 断言的是「导入后的主机与普通主机外部同构」这条要求的可测部分：
#   1. 签名串与 Authorization 头逐字（固定时间 → 已知 HMAC），方法小写、路径带查询串；
#   2. 120 字节级的前缀 + 首尾标记的切片：二进制载荷逐字节一致、跨块切分不影响；
#   2b. ssh_run 的执行包装与退出码标记：`2>&1` 合并 stderr、`@@DSH_RC=1/0/127` 解析、取最后一个、
#      剔除干净、解析不到退回通道 code；
#   3. hosts.json 的来源标记：写入 / 读回 / 忽略非法标记 / 删除即取消导入 / 手工再填一次不降级 /
#      同身份只更新导入条目、直连条目只让路；`targetLabel` 在备注等于地址或 id 时不重复；
#      备注（set_label）的入参与写回；
#   4. 两张卡的载荷：表单卡四个字段（密钥不预填、接入端口预填 2222）与多选卡的每行 `IP:22`
#      （名称不同才带名称、没有重复正文）、已导入标记；
#   5. 用户可见文案里没有产品名（JumpServer / JMS / 令牌）。
# 真实建连（HTTP 签名、KoKo 通道、122 字节前缀的实测值）不在这里，见 DECISIONS.md 的未验清单。
#
# 说明：纯 PS 断言脚本不拆文件（仓库规范 §2 例外），断言数量本身就是基线。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $pluginRoot 'scripts\ui\card.ps1')

$failures = 0
$checks = 0
function Check([string]$Name, [scriptblock]$Body) {
    $script:checks++
    try {
        $result = & $Body
        if ($result -eq $true) { "ok  $Name" }
        else { "FAIL $Name → $result"; $script:failures++ }
    } catch {
        "FAIL $Name → 抛异常：$($_.Exception.Message)"; $script:failures++
    }
}

# ---- 用一小段 node 脚本算出「事实」，再全部回到 PS 里断言 -------------------------------
# 为什么绕这一圈：纯函数的输入输出只有 JS 侧才拿得到，而断言要留在 PS（与其它 tests\*.ps1 同一形态）。
# 结果写文件而不是 stdout：受限沙箱下 PS 消费 native 输出会失败，这里干脆不碰管道。
$work = Join-Path $PSScriptRoot '.tmp-jms'
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$null = New-Item -ItemType Directory -Path $work
$harness = Join-Path $work 'facts.mjs'
$outFile = Join-Path $work 'facts.json'

$harnessCode = @'
// 生成测试事实：只调用纯函数，不联网、不读真密码库、不写 hosts.json。
// 用法：node facts.mjs <插件根> <输出 JSON>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
const out = process.argv[3]
const load = (rel) => import(pathToFileURL(join(root, rel)).href)

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function slice(chunks) {
  return collect(Readable.from(chunks, { objectMode: false }).pipe(stream_createStripper()))
}

let stream_createStripper

async function main() {
  const facts = {}

  // ---- 1. 签名 --------------------------------------------------------------
  const sign = await load('lib/jms/sign.mjs')
  const date = sign.httpDate(new Date(Date.UTC(2026, 10, 11, 5, 44, 15)))
  facts.sign = {
    date,
    post: sign.buildSignature({
      appid: 'ak-test',
      secret: 'sk-test',
      method: 'POST',
      path: '/api/v1/authentication/connection-token/',
      date,
    }),
    get: sign.buildSignature({
      appid: 'ak-test',
      secret: 'sk-test',
      method: 'GET',
      path: '/api/v1/perms/users/self/assets/?limit=100',
      date,
    }),
    otherSecret: sign.buildSignature({
      appid: 'ak-test',
      secret: 'sk-other',
      method: 'POST',
      path: '/api/v1/authentication/connection-token/',
      date,
    }),
  }
  // 同一个 path 换大小写的方法：待签串与签名都必须一模一样。
  facts.sign.lower = sign.buildSignature({
    appid: 'ak-test',
    secret: 'sk-test',
    method: 'get',
    path: '/api/v1/perms/users/self/assets/?limit=100',
    date,
  })

  // ---- 2. 标记与切片 --------------------------------------------------------
  const stream = await load('lib/jms/stream.mjs')
  stream_createStripper = () => stream.createMarkerStripper()
  const prefix = Buffer.alloc(122, 0x2e)
  const payload = Buffer.from([0x00, 0x01, 0x02, 0x0a, 0x0d, 0x40, 0x40, 0xff, 0xfe, 0x41, 0x42, 0x43])
  const begin = Buffer.from(stream.MARK_BEGIN)
  const end = Buffer.from(stream.MARK_END)
  const wire = Buffer.concat([prefix, begin, payload, end])

  let missingError = ''
  try {
    await slice([Buffer.alloc(500, 0x2e)])
  } catch (error) {
    missingError = String(error?.message ?? error)
  }

  facts.stream = {
    marks: { begin: stream.MARK_BEGIN, end: stream.MARK_END },
    wrap: stream.wrapReadCommand('cat /etc/hosts'),
    wrapTar: stream.wrapReadCommand("tar -cf - -C '/srv app' -- 'conf'"),
    payloadHex: payload.toString('hex'),
    prefixLength: prefix.length,
    wholeHex: (await slice([wire])).toString('hex'),
    splitHex: (
      await slice([
        wire.subarray(0, 60),
        wire.subarray(60, 122 + 3),
        wire.subarray(122 + 3, 122 + begin.length + 2),
        wire.subarray(122 + begin.length + 2),
      ])
    ).toString('hex'),
    noEndHex: (await slice([Buffer.concat([prefix, begin, payload])])).toString('hex'),
    stripText: stream.stripMarkedText(Buffer.concat([prefix, begin, Buffer.from('type=file\nsize=12\n'), end]).toString('latin1')),
    stripPlain: stream.stripMarkedText('type=file\nsize=12\n'),
    missingError,
  }

  // ---- 2b. ssh_run 的执行包装与 stdout 切片 ---------------------------------
  const execWire = Buffer.concat([prefix, begin, Buffer.from('hello\nworld\n'), end]).toString('latin1')
  // 切在前缀之后、标记中间（第 125 字节落在起始标记里）：exec 侧是「拼完再切」，分块不该影响结果。
  const execWireSplit = [execWire.slice(0, 125), execWire.slice(125)]
  facts.exec = {
    single: stream.wrapExecCommand('cat /etc/hosts'),
    multi: stream.wrapExecCommand('set -e\ncd /tmp && ls -1 | head -n 2'),
    withCwd: stream.wrapExecCommand("cd -- '/srv/app' || exit 1\necho ok"),
    strip: stream.stripMarkedText(execWire),
    stripEmpty: stream.stripMarkedText('x'.repeat(122) + stream.MARK_BEGIN + stream.MARK_END),
    stripNoBegin: stream.stripMarkedText('x'.repeat(122) + 'plain output\n'),
    stripNoEnd: stream.stripMarkedText('x'.repeat(122) + stream.MARK_BEGIN + 'tail only\n'),
    stripJoinedChunks: stream.stripMarkedText(execWireSplit.join('')),
  }

  // 2c. 退出码标记的解析（接入点的 exit-status 恒为 0，只能靠 stdout 里带回的值）
  const rcText = (body, rc) => `${body}\n@@DSH_RC=${rc}@@\n`
  facts.exec.rc = {
    one: stream.parseExecOutput(rcText('out one\n', 1)),
    zero: stream.parseExecOutput(rcText('', 0)),
    notFound: stream.parseExecOutput(rcText('sh: no such file\n', 127)),
    // 命令自己 echo 了同名串：必须取最后一个（我们打印的那个），并从文本里剔掉那一个。
    last: stream.parseExecOutput('spoof\n@@DSH_RC=3@@\nreal\n\n@@DSH_RC=0@@\n'),
    missing: stream.parseExecOutput('plain output\n'),
    noTrailingNewline: stream.parseExecOutput(rcText('abc', 5)),
  }

  // exec 侧的定码规则：解析到就用它，解析不到才退回通道给的 code。
  const execModule = await load('lib/pool/exec.mjs')
  facts.exec.resolve = {
    parsedWins: execModule.resolveExitCode(1, 0),
    parsedZero: execModule.resolveExitCode(0, 0),
    parsed127: execModule.resolveExitCode(127, 0),
    fallback: execModule.resolveExitCode(null, 9),
    none: execModule.resolveExitCode(null, null),
  }

  // ---- 3. hosts.json 的来源标记 --------------------------------------------
  const hosts = await load('lib/hosts.mjs')
  const adminModule = await load('lib/admin.mjs')
  const jmsHosts = await load('lib/jms/hosts.mjs')

  const via = { assetId: '17', accountAlias: 'acc-root', accountUser: 'root' }
  const doc = hosts.normalizeHostsDocument({
    hosts: {
      '192.168.1.5': { address: '192.168.1.5', port: 22, user: 'root', label: 'Web 1', via },
      '192.168.1.6': { address: '192.168.1.6', port: 22, user: 'root', label: '普通机' },
    },
  })
  facts.hosts = {
    via: doc.hosts['192.168.1.5'].via,
    plainHasVia: doc.hosts['192.168.1.6'].via !== undefined,
    isJms: jmsHosts.isJmsHost(doc.hosts['192.168.1.5']),
    isJmsPlain: jmsHosts.isJmsHost(doc.hosts['192.168.1.6']),
    label: hosts.targetLabel(doc.hosts['192.168.1.5']),
    labelPlain: hosts.targetLabel(doc.hosts['192.168.1.6']),
    serialized: adminModule.serializeHostsDocument(doc),
    importedIds: [...jmsHosts.importedAssetIds(doc.hosts)],
  }

  const bad = hosts.normalizeHostsDocument(
    { hosts: { '192.168.1.7': { address: '192.168.1.7', port: 22, user: 'root', via: { assetId: '9' } } } },
    { warnings: [] },
  )
  facts.hosts.badViaDropped = bad.hosts['192.168.1.7'].via === undefined
  facts.hosts.badViaWarning = (bad.warnings ?? []).join('\n')

  facts.hosts.keptViaOnUpsert = adminModule.upsertHost(doc, {
    address: '192.168.1.5',
    port: 22,
    user: 'root',
    label: '改个名',
  }).host.via

  const imported = jmsHosts.applyAssetImports(
    { hosts: {} },
    [{ asset: { id: '21', name: 'DB 1', address: '192.168.1.8' }, account: { alias: 'acc-db', username: 'mysql' } }],
  )
  facts.hosts.imported = { id: imported.added[0].id, host: imported.added[0], count: imported.added.length }

  const taken = {
    hosts: {
      '192.168.1.9': { id: '192.168.1.9', kind: 'remote', address: '10.9.9.9', port: 22, user: 'ubuntu', label: '别的机器', tags: [] },
    },
  }
  const conflict = jmsHosts.applyAssetImports(taken, [
    { asset: { id: '22', name: 'Web 2', address: '192.168.1.9' }, account: { alias: 'acc-2', username: 'root' } },
  ])
  facts.hosts.conflict = {
    id: conflict.added[0].id,
    kept: conflict.document.hosts['192.168.1.9'],
  }

  // 同一个「资产 + 账号」再导一次 → 更新那一条（不新增、id 不变、备注与账号跟进）。
  const viaDoc = {
    hosts: {
      '192.168.1.20': {
        id: '192.168.1.20',
        kind: 'remote',
        address: '192.168.1.20',
        port: 22,
        user: 'root',
        label: '旧名',
        tags: ['t1'],
        via: { assetId: '5', accountAlias: 'acc-a', accountUser: 'root' },
      },
    },
  }
  const sameIdentity = jmsHosts.applyAssetImports(viaDoc, [
    { asset: { id: '5', name: '新名', address: '192.168.1.20' }, account: { alias: 'acc-a', username: 'root' } },
  ])
  facts.hosts.updateSameIdentity = {
    added: sameIdentity.added.length,
    updated: sameIdentity.updated.length,
    keys: Object.keys(sameIdentity.document.hosts),
    id: sameIdentity.updated[0].id,
    label: sameIdentity.updated[0].label,
    via: sameIdentity.updated[0].via,
  }

  // 同一台资产的**另一个账号**（用户名恰好也撞了）→ 让路新增，已有那条的别名不被改写。
  const otherAccount = jmsHosts.applyAssetImports(viaDoc, [
    { asset: { id: '5', name: '新名', address: '192.168.1.20' }, account: { alias: 'acc-z', username: 'root' }, accountCount: 2 },
  ])
  facts.hosts.otherAccount = {
    added: otherAccount.added.length,
    updated: otherAccount.updated.length,
    newId: otherAccount.added[0]?.id ?? '',
    newAlias: otherAccount.added[0]?.via?.accountAlias ?? '',
    newLabel: otherAccount.added[0]?.label ?? '',
    keptAlias: otherAccount.document.hosts['192.168.1.20'].via.accountAlias,
    keys: Object.keys(otherAccount.document.hosts),
  }

  // 一台资产两个账号（example / root）→ 两台主机，备注都带用户名（D-47）。
  const multi = jmsHosts.applyAssetImports(
    { hosts: {} },
    [
      { asset: { id: '7', name: 'Web 1', address: '192.168.1.11' }, account: { alias: 'example', username: 'example' }, accountCount: 2 },
      { asset: { id: '7', name: 'Web 1', address: '192.168.1.11' }, account: { alias: 'root', username: 'root' }, accountCount: 2 },
    ],
  )
  facts.hosts.multiAccount = {
    count: multi.added.length,
    labels: multi.added.map((host) => host.label),
    aliases: multi.added.map((host) => host.via.accountAlias),
    users: multi.added.map((host) => host.user),
    ids: multi.added.map((host) => host.id),
  }
  facts.hosts.importedKeys = [...jmsHosts.importedAccountKeys(viaDoc.hosts)]

  // 同身份却是直连条目（真实环境里不会有）→ 让路：新增一条新 id，原有那台一个字都不改。
  const directDoc = {
    hosts: {
      keep: { id: 'keep', kind: 'remote', address: '192.168.1.21', port: 22, user: 'root', label: '直连那台', tags: ['prod'] },
    },
  }
  const letGo = jmsHosts.applyAssetImports(directDoc, [
    { asset: { id: '7', name: '资产名', address: '192.168.1.21' }, account: { alias: 'acc-c', username: 'root' } },
  ])
  facts.hosts.letGo = {
    added: letGo.added.length,
    updated: letGo.updated.length,
    newId: letGo.added[0].id,
    original: letGo.document.hosts.keep,
    addedVia: letGo.added[0].via,
  }

  // targetLabel 去重：备注等于地址或 id（大小写不敏感）时不再拼「 · 备注」。
  facts.hosts.labelDedupe = {
    sameAddress: hosts.targetLabel({ kind: 'remote', id: '192.168.1.9', address: '192.168.1.9', port: 22, label: '192.168.1.9' }),
    sameId: hosts.targetLabel({ kind: 'remote', id: 'web1', address: '192.168.1.11', port: 22, label: 'WEB1' }),
    noLabel: hosts.targetLabel({ kind: 'remote', id: 'x1', address: '192.168.1.13', port: 22 }),
    distinct: hosts.targetLabel({ kind: 'remote', id: '192.168.1.5', address: '192.168.1.5', port: 22, label: 'Web 1' }),
  }

  // set_label：纯函数入参校验（会话侧已删 set_label 动作，设置页仍在用这两个函数）。
  const setLabelError = (fn) => {
    try {
      fn()
      return ''
    } catch (error) {
      return String(error?.message ?? error)
    }
  }
  const labelEdit = adminModule.setHostLabel(doc, '192.168.1.5', '生产 Web')
  facts.hosts.setLabel = {
    label: labelEdit.host.label,
    previous: labelEdit.previousLabel,
    changed: labelEdit.changed,
    address: labelEdit.host.address,
    port: labelEdit.host.port,
    user: labelEdit.host.user,
    via: labelEdit.host.via,
    fallback: adminModule.setHostLabel(doc, '192.168.1.5', '   ').host.label,
    emptyId: setLabelError(() => adminModule.setHostLabel(doc, '  ', 'x')),
    unknownId: setLabelError(() => adminModule.setHostLabel(doc, 'nope', 'x')),
  }

  // 列表里导入过的主机怎么显示：不能写成「无密码」（它本来就没有密码这条路径）。
  const fakeStore = {
    ensureLoaded: async () => undefined,
    hosts: doc.hosts,
    wsl: {},
    hostDefaults: doc.defaults,
    warnings: [],
    vault: { has: () => false },
  }
  facts.list = await adminModule.createAdmin({ store: fakeStore, paths: {}, dialog: null, pool: null }).list()
  facts.list.warnings = undefined

  return facts
}

const facts = await main()
writeFileSync(out, JSON.stringify(facts, null, 2), 'utf8')
'@

[System.IO.File]::WriteAllText($harness, $harnessCode, [System.Text.UTF8Encoding]::new($false))

try {
    & node $harness $pluginRoot $outFile
    if ($LASTEXITCODE -ne 0) { throw "生成测试事实失败（node 退出码 $LASTEXITCODE）" }
    if (-not (Test-Path -LiteralPath $outFile)) { throw '生成测试事实失败：没有产出文件' }
    $facts = Get-Content -Raw -LiteralPath $outFile | ConvertFrom-Json

    # ---- 1. 签名：待签串与头都必须逐字 -------------------------------------------------
    Check '签名：固定时间 → RFC1123 GMT 串' {
        if ($facts.sign.date -ne 'Wed, 11 Nov 2026 05:44:15 GMT') { return "得到 $($facts.sign.date)" }
        $true
    }

    Check '签名：POST 待签串（小写方法 + 尾斜杠）逐字' {
        $expected = "(request-target): post /api/v1/authentication/connection-token/`ndate: Wed, 11 Nov 2026 05:44:15 GMT"
        if ($facts.sign.post.stringToSign -ne $expected) { return "待签串不对：$($facts.sign.post.stringToSign)" }
        $true
    }

    Check '签名：POST 结果等于已知 HMAC（密钥 sk-test）' {
        if ($facts.sign.post.signature -ne 'UpTbVfVkBe2suKOv6JUOxtraiOJuCeSbf2EzlqTKxqs=') {
            return "签名不对：$($facts.sign.post.signature)"
        }
        $true
    }

    Check '签名：GET 待签串带查询串（少了它服务端认成另一个串）' {
        $expected = "(request-target): get /api/v1/perms/users/self/assets/?limit=100`ndate: Wed, 11 Nov 2026 05:44:15 GMT"
        if ($facts.sign.get.stringToSign -ne $expected) { return "待签串不对：$($facts.sign.get.stringToSign)" }
        if ($facts.sign.get.signature -ne '7mryrILeKpj3+Ex0Oo7fZcaJYb9le29R05UyTxbFqY4=') { return "签名不对：$($facts.sign.get.signature)" }
        $true
    }

    Check '签名：方法大小写不影响结果；换密钥结果必须变' {
        if ($facts.sign.lower.stringToSign -ne $facts.sign.get.stringToSign) { return '大写 GET 与小写 get 的待签串不一致' }
        if ($facts.sign.lower.signature -ne $facts.sign.get.signature) { return '大写 GET 与小写 get 的签名不一致' }
        if ($facts.sign.otherSecret.signature -eq $facts.sign.post.signature) { return '换了密钥签名却没变' }
        $true
    }

    Check '签名：Authorization 头四段格式，且签名与 signature 字段一致' {
        $auth = [string]$facts.sign.post.authorization
        $expected = 'Signature keyId="ak-test",algorithm="hmac-sha256",headers="(request-target) date",signature="' +
            $facts.sign.post.signature + '"'
        if ($auth -ne $expected) { return "头不对：$auth" }
        $true
    }

    # ---- 2. 标记与切片 ---------------------------------------------------------------
    Check '切片：读取命令被首尾标记包住，原命令不动' {
        $expected = "printf '@@DSH_B@@'; cat /etc/hosts; printf '@@DSH_E@@'"
        if ($facts.stream.wrap -ne $expected) { return "得到 $($facts.stream.wrap)" }
        $true
    }

    Check '切片：tar 源命令同样只包标记（引号原样保留）' {
        $expected = "printf '@@DSH_B@@'; tar -cf - -C '/srv app' -- 'conf'; printf '@@DSH_E@@'"
        if ($facts.stream.wrapTar -ne $expected) { return "得到 $($facts.stream.wrapTar)" }
        $true
    }

    Check '切片：122 字节前缀 + 标记 + 二进制载荷 → 输出逐字节等于载荷' {
        if ($facts.stream.prefixLength -ne 122) { return "前缀长度 $($facts.stream.prefixLength)" }
        if ($facts.stream.wholeHex -ne $facts.stream.payloadHex) {
            return "载荷不一致：得到 $($facts.stream.wholeHex)，期望 $($facts.stream.payloadHex)"
        }
        $true
    }

    Check '切片：跨块切分（切在标记中间、载荷中间）不影响结果' {
        if ($facts.stream.splitHex -ne $facts.stream.payloadHex) {
            return "载荷不一致：得到 $($facts.stream.splitHex)"
        }
        $true
    }

    Check '切片：没有结束标记（对端提前关流）时已收到的载荷仍然完整' {
        if ($facts.stream.noEndHex -ne $facts.stream.payloadHex) { return "载荷不一致：得到 $($facts.stream.noEndHex)" }
        $true
    }

    Check '切片：没有起始标记 → 明确报错（不静默把前缀当数据）' {
        if ($facts.stream.missingError -eq '') { return '没有抛异常' }
        if ($facts.stream.missingError -notmatch '标记') { return "错误里没说清：$($facts.stream.missingError)" }
        $true
    }

    Check '切片：预检文本（非流式）去前缀；没有标记时原样返回' {
        if ($facts.stream.stripText -ne "type=file`nsize=12`n") { return "去前缀后不对：$($facts.stream.stripText)" }
        if ($facts.stream.stripPlain -ne "type=file`nsize=12`n") { return "无标记时不该改动：$($facts.stream.stripPlain)" }
        $true
    }

    # ---- 2b. ssh_run：执行包装 + stdout 切片 ------------------------------------------
    $markBegin = $facts.stream.marks.begin
    $markEnd = $facts.stream.marks.end

    Check '执行包装：单行命令逐字（子 shell + 2>&1 + 取 $? + 退出码写进 stdout + 结束标记）' {
        $expected = "printf '$markBegin'; ( cat /etc/hosts ) 2>&1; __dsh_rc=`$?; printf '\n@@DSH_RC=%s@@\n' `"`$__dsh_rc`"; printf '$markEnd'"
        if ($facts.exec.single -ne $expected) { return "包装串不对：$($facts.exec.single)" }
        $true
    }

    Check '执行包装：顺序严格（子 shell 2>&1 → 取 $? → 打印退出码 → 结束标记），且不再 exit' {
        $text = [string]$facts.exec.single
        if ($text.IndexOf('2>&1') -lt $text.IndexOf('( cat')) { return '2>&1 不在子 shell 之后' }
        if ($text.IndexOf('__dsh_rc=$?') -lt $text.IndexOf('2>&1')) { return '取 $? 不在 2>&1 之后' }
        if ($text.IndexOf('@@DSH_RC=') -lt $text.IndexOf('__dsh_rc=$?')) { return '退出码标记不在取 $? 之后' }
        if ($text.IndexOf($markEnd) -lt $text.IndexOf('@@DSH_RC=')) { return '结束标记不在退出码标记之后' }
        if ($text -match 'exit\s+\$__dsh_rc') { return '还留着 exit $__dsh_rc（通道退出码不可信，已改为标记带回）' }
        $true
    }

    Check '执行包装：多行命令右括号另起一行（末行可能是注释）' {
        $expected = "printf '$markBegin'; ( set -e`ncd /tmp && ls -1 | head -n 2`n) 2>&1; __dsh_rc=`$?; printf '\n@@DSH_RC=%s@@\n' `"`$__dsh_rc`"; printf '$markEnd'"
        if ($facts.exec.multi -ne $expected) { return "包装串不对：$($facts.exec.multi)" }
        $true
    }

    Check '执行包装：cwd 的 cd 也关在子 shell 里，失败仍以原命令的退出码收场' {
        $expected = "printf '$markBegin'; ( cd -- '/srv/app' || exit 1`necho ok`n) 2>&1; __dsh_rc=`$?; printf '\n@@DSH_RC=%s@@\n' `"`$__dsh_rc`"; printf '$markEnd'"
        if ($facts.exec.withCwd -ne $expected) { return "包装串不对：$($facts.exec.withCwd)" }
        if ($facts.exec.withCwd -notmatch '2>&1') { return '多行命令没有合并 stderr' }
        $true
    }

    Check '执行切片：前缀 + 输出 + 结束标记 → 只剩输出，末尾不多一个换行' {
        if ($facts.exec.strip -ne "hello`nworld`n") { return "得到 $($facts.exec.strip)" }
        $true
    }

    Check '执行切片：输出为空 → 空串（不把标记本身留下）' {
        if ($facts.exec.stripEmpty -ne '') { return "得到「$($facts.exec.stripEmpty)」" }
        $true
    }

    Check '执行切片：没有起始标记 → 原样返回（不报错，也不吞内容）' {
        $plain = 'x' * 122 + 'plain output' + "`n"
        if ($facts.exec.stripNoBegin -ne $plain) { return "得到「$($facts.exec.stripNoBegin)」" }
        $true
    }

    Check '执行切片：只有起始标记、没有结束标记 → 交出标记之后的全部内容' {
        if ($facts.exec.stripNoEnd -ne "tail only`n") { return "得到「$($facts.exec.stripNoEnd)」" }
        $true
    }

    Check '执行切片：分块只影响字节流路径；拼好的文本切片与整段一致' {
        if ($facts.exec.stripJoinedChunks -ne $facts.exec.strip) {
            return "分块后不一致：$($facts.exec.stripJoinedChunks)"
        }
        $true
    }

    Check '退出码：@@DSH_RC=1 / 0 / 127 三段都取出来，且从可见输出里剔干净' {
        if ($facts.exec.rc.one.exitCode -ne 1) { return "=1 取出 $($facts.exec.rc.one.exitCode)" }
        if ($facts.exec.rc.zero.exitCode -ne 0) { return "=0 取出 $($facts.exec.rc.zero.exitCode)" }
        if ($facts.exec.rc.notFound.exitCode -ne 127) { return "=127 取出 $($facts.exec.rc.notFound.exitCode)" }
        if ($facts.exec.rc.one.stdout -ne "out one`n") { return "=1 的输出是「$($facts.exec.rc.one.stdout)」" }
        if ($facts.exec.rc.zero.stdout -ne '') { return "空输出留下了「$($facts.exec.rc.zero.stdout)」" }
        if ($facts.exec.rc.notFound.stdout -ne "sh: no such file`n") { return "=127 的输出是「$($facts.exec.rc.notFound.stdout)」" }
        foreach ($item in @($facts.exec.rc.one, $facts.exec.rc.zero, $facts.exec.rc.notFound, $facts.exec.rc.noTrailingNewline)) {
            if ([string]$item.stdout -match '@@DSH_RC=') { return "标记没剔干净：「$($item.stdout)」" }
        }
        $true
    }

    Check '退出码：命令自己 echo 同名串时取最后一个；末尾没有换行也不多空行' {
        if ($facts.exec.rc.last.exitCode -ne 0) { return "取了 $($facts.exec.rc.last.exitCode)" }
        if ($facts.exec.rc.last.stdout -ne "spoof`n@@DSH_RC=3@@`nreal`n") { return "文本是「$($facts.exec.rc.last.stdout)」" }
        if ($facts.exec.rc.noTrailingNewline.exitCode -ne 5) { return "=5 取出 $($facts.exec.rc.noTrailingNewline.exitCode)" }
        if ($facts.exec.rc.noTrailingNewline.stdout -ne 'abc') { return "文本是「$($facts.exec.rc.noTrailingNewline.stdout)」" }
        $true
    }

    Check '退出码：解析不到 → null；exec 侧按「标记优先、通道兜底」定码' {
        if ($null -ne $facts.exec.rc.missing.exitCode) { return "解析不到却给了 $($facts.exec.rc.missing.exitCode)" }
        if ($facts.exec.rc.missing.stdout -ne "plain output`n") { return '解析不到时不该改文本' }
        if ($facts.exec.resolve.parsedWins -ne 1) { return '标记里的 1 没有优先于通道的 0' }
        if ($facts.exec.resolve.parsedZero -ne 0) { return '标记里的 0 没生效' }
        if ($facts.exec.resolve.parsed127 -ne 127) { return '标记里的 127 没生效' }
        if ($facts.exec.resolve.fallback -ne 9) { return "解析不到时应退回通道 code，得到 $($facts.exec.resolve.fallback)" }
        if ($null -ne $facts.exec.resolve.none) { return '两边都没有时应为 null（断链判断用它）' }
        $true
    }

    Check '接线：exec.mjs 只对带标记的主机包命令，且只切 stdout、退出码以标记为准' {
        $text = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'lib\pool\exec.mjs')
        if ($text -notmatch 'viaExec \? wrapExecCommand\(wrapCommand\(command, cwd\)\)') { return '命令没有按主机分支包标记' }
        if ($text -notmatch "parseExecOutput\(stripMarkedText\(rawStdout\.toString\('utf8'\)\)\)") { return 'stdout 没有先切片再取退出码' }
        if ($text -notmatch 'resolveExitCode\(parsed\.exitCode') { return '退出码没有以 stdout 带回的标记为准' }
        if ($text -match 'stripMarkedText\([^)]*stderr') { return 'stderr 被切了（前缀只加在 stdout）' }
        if ($text -notmatch 'isJmsHost\(host\)') { return '没有用来源标记判定' }
        $true
    }

    # ---- 3. hosts.json 的来源标记 ----------------------------------------------------
    Check '标记：写盘后读回，assetId / 账号别名 / 账号用户名都在' {
        $via = $facts.hosts.via
        if ($via.assetId -ne '17' -or $via.accountAlias -ne 'acc-root' -or $via.accountUser -ne 'root') {
            return "读回的标记不对：$($via | ConvertTo-Json -Compress)"
        }
        $true
    }

    Check '标记：普通主机没有这条记录（两种主机混在同一份 hosts.json）' {
        if ($facts.hosts.plainHasVia -ne $false) { return '普通主机被写上了来源标记' }
        $true
    }

    Check '标记：写回 hosts.json 时带上标记，且不写内部合成字段 id / kind' {
        $entries = @($facts.hosts.serialized.hosts.PSObject.Properties)
        $first = $entries[0].Value
        if ($first.PSObject.Properties.Name -contains 'id') { return '写回了 id' }
        if ($first.PSObject.Properties.Name -contains 'kind') { return '写回了 kind' }
        if ($null -eq $first.PSObject.Properties['via']) { return '没有写 via' }
        $true
    }

    Check '标记：判定函数认标记、认普通主机' {
        if ($facts.hosts.isJms -ne $true) { return '带标记的没认出来' }
        if ($facts.hosts.isJmsPlain -ne $false) { return '普通主机被认成了导入主机' }
        $true
    }

    Check '标记：目标标签与普通主机同形（地址:端口 · 别名），不带任何来源字样' {
        if ($facts.hosts.label -ne '192.168.1.5:22 · Web 1') { return "得到 $($facts.hosts.label)" }
        if ($facts.hosts.label -ne $facts.hosts.labelPlain.Replace('192.168.1.6', '192.168.1.5').Replace('普通机', 'Web 1')) {
            return '与普通主机的标签形状不一致'
        }
        if ($facts.hosts.label -match '(?i)jumpserver|jms|令牌') { return "标签里出现了来源字样：$($facts.hosts.label)" }
        $true
    }

    Check '标记：targetLabel 在备注等于地址或 id（大小写不敏感）时不再拼「 · 备注」' {
        $dedupe = $facts.hosts.labelDedupe
        if ($dedupe.sameAddress -ne '192.168.1.9:22') { return "备注等于地址时得到 $($dedupe.sameAddress)" }
        if ($dedupe.sameId -ne '192.168.1.11:22') { return "备注等于 id 时得到 $($dedupe.sameId)" }
        if ($dedupe.noLabel -ne '192.168.1.13:22') { return "没有备注时得到 $($dedupe.noLabel)" }
        if ($dedupe.distinct -ne '192.168.1.5:22 · Web 1') { return "备注不同时得到 $($dedupe.distinct)" }
        $true
    }

    Check '标记：不完整的标记被忽略（按普通主机连接）并记一条 warning' {
        if ($facts.hosts.badViaDropped -ne $true) { return '不完整的标记仍然生效了' }
        if ($facts.hosts.badViaWarning -notmatch '来源标记不完整') { return "warning 不对：$($facts.hosts.badViaWarning)" }
        $true
    }

    Check '导入：id 取自资产 IP，user 取账号用户名，port 22' {
        $importedHost = $facts.hosts.imported.host
        if ($importedHost.id -ne '192.168.1.8') { return "id 是 $($importedHost.id)" }
        if ($importedHost.user -ne 'mysql') { return "user 是 $($importedHost.user)" }
        if ($importedHost.port -ne 22) { return "port 是 $($importedHost.port)" }
        if ($importedHost.label -ne 'DB 1') { return "label 是 $($importedHost.label)" }
        $true
    }

    Check '导入：id 撞上已有主机时让路，已有那台一个字都不改' {
        if ($facts.hosts.conflict.id -eq '192.168.1.9') { return '复用了已占用的 id' }
        if ($facts.hosts.conflict.kept.address -ne '10.9.9.9') { return "既有主机被改了：$($facts.hosts.conflict.kept.address)" }
        $true
    }

    Check '导入：同一台资产的两个账号 → 两台主机，备注都带用户名，来源别名各自正确' {
        $m = $facts.hosts.multiAccount
        if ($m.count -ne 2) { return "新增了 $($m.count) 台" }
        if ((@($m.labels) -join '|') -ne 'Web 1 · example|Web 1 · root') { return "备注是 $((@($m.labels)) -join '|')" }
        if ((@($m.aliases) -join '|') -ne 'example|root') { return "别名是 $((@($m.aliases)) -join '|')" }
        if ((@($m.users) -join '|') -ne 'example|root') { return "用户是 $((@($m.users)) -join '|')" }
        if ((@($m.ids) -join '|') -ne '192.168.1.11|192.168.1.11-22') { return "id 是 $((@($m.ids)) -join '|')" }
        $true
    }

    Check '导入：同一台资产的另一个账号不覆盖已有那条（按资产 + 账号判重）' {
        $o = $facts.hosts.otherAccount
        if ($o.added -ne 1) { return "新增了 $($o.added) 条" }
        if ($o.updated -ne 0) { return "改写了 $($o.updated) 条" }
        if ($o.newAlias -ne 'acc-z') { return "新那条的别名是 $($o.newAlias)" }
        if ($o.newId -eq '192.168.1.20') { return '复用了已有那台的 id' }
        if ($o.keptAlias -ne 'acc-a') { return "已有那台的别名被改成了 $($o.keptAlias)" }
        if ($o.newLabel -ne '新名 · root') { return "多账号资产的备注是 $($o.newLabel)" }
        if ((@($o.keys)).Count -ne 2) { return "文档里有 $((@($o.keys)).Count) 条" }
        $true
    }

    Check '账号键：已导入按「资产 id + 账号别名」判定，不看用户名' {
        if ((@($facts.hosts.importedKeys) -join ',') -ne '5|acc-a') { return "键是 $((@($facts.hosts.importedKeys)) -join ',')" }
        $true
    }

    Check '导入：同身份且已是导入条目 → 更新那一台（不新增，id 不变，备注与账号跟进）' {
        $upd = $facts.hosts.updateSameIdentity
        if ($upd.added -ne 0) { return "新增了 $($upd.added) 条" }
        if ($upd.updated -ne 1) { return "更新了 $($upd.updated) 条" }
        if ((@($upd.keys)).Count -ne 1) { return "文档里有 $((@($upd.keys)).Count) 条" }
        if ($upd.id -ne '192.168.1.20') { return "id 变成 $($upd.id)" }
        if ($upd.label -ne '新名') { return "备注没跟进：$($upd.label)" }
        if ($upd.via.assetId -ne '5') { return "来源标记没跟进：$($upd.via.assetId)" }
        if ($upd.via.accountAlias -ne 'acc-a') { return "账号别名没跟上：$($upd.via.accountAlias)" }
        $true
    }

    Check '导入：同身份的直连条目（真实环境不会有）→ 让路新增，原有那台一个字都不改' {
        $let = $facts.hosts.letGo
        if ($let.added -ne 1) { return "新增了 $($let.added) 条" }
        if ($let.updated -ne 0) { return "改写了 $($let.updated) 条" }
        if ($let.newId -eq 'keep') { return '复用了直连条目的 id' }
        if ($let.addedVia.assetId -ne '7') { return '新增的那条没有来源标记' }
        $orig = $let.original
        if ($orig.address -ne '192.168.1.21' -or $orig.port -ne 22 -or $orig.user -ne 'root') { return '原有条目的地址/端口/用户被改了' }
        if ($orig.label -ne '直连那台') { return "原有条目的备注被改成了 $($orig.label)" }
        if ((@($orig.tags) -join ',') -ne 'prod') { return '原有条目的标签被改了' }
        if ($null -ne $orig.PSObject.Properties['via']) { return '原有条目被补上了来源标记（= 接管）' }
        $true
    }

    Check '备注：set_label 的入参校验（id 不能为空、找不到主机要报错）' {
        if ($facts.hosts.setLabel.emptyId -notmatch 'id 不能为空') { return "空 id 的报错是「$($facts.hosts.setLabel.emptyId)」" }
        if ($facts.hosts.setLabel.unknownId -notmatch '没有配置主机') { return "未知 id 的报错是「$($facts.hosts.setLabel.unknownId)」" }
        $true
    }

    Check '备注：set_label 只改备注（地址/端口/用户/来源标记都不动），留空退回地址' {
        $s = $facts.hosts.setLabel
        if ($s.label -ne '生产 Web') { return "新备注是 $($s.label)" }
        if ($s.previous -ne 'Web 1') { return "旧备注是 $($s.previous)" }
        if ($s.changed -ne $true) { return 'changed 不是 true' }
        if ($s.address -ne '192.168.1.5' -or $s.port -ne 22 -or $s.user -ne 'root') { return '地址/端口/用户被改了' }
        if ($s.via.assetId -ne '17') { return '来源标记被抹掉了' }
        if ($s.fallback -ne '192.168.1.5') { return "留空时退回的是「$($s.fallback)」" }
        $true
    }

    Check '列表：导入过的主机显示「凭据已接入」，不写成「无密码」' {
        $line = @($facts.list.lines) | Where-Object { $_ -like '192.168.1.5*' }
        if ($null -eq $line) { return "列表里没有这台：$($facts.list.lines -join ' / ')" }
        if ($line -notmatch '凭据已接入') { return "列表行是 $line" }
        $true
    }


    Check '文案：用户可见串里没有产品名（JumpServer / JMS / 令牌）' {
        $subject = (@($facts.hosts | ConvertTo-Json -Depth 8), ($facts.list | ConvertTo-Json -Depth 8)) -join "`n"
        foreach ($word in @('JumpServer', 'JMS', '令牌')) {
            if ($subject -match [regex]::Escape($word)) { return "文案里出现产品名：$word" }
        }
        $true
    }

    Check '接线：dialog.ps1 只剩 select 模式（B-47），抬头仍可透传' {
        $dialog = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'scripts\dialog.ps1')
        if (-not $dialog.Contains("ValidateSet('select')")) { return 'Mode 白名单不是只有 select' }
        if ($dialog -match "'confirm'|'form'") { return 'dialog.ps1 还收 confirm / form 模式' }
        if (-not $dialog.Contains('Eyebrow')) { return 'dialog.ps1 不收 -Eyebrow 了' }
        $true
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -gt 0) {
    "`n$failures 项失败"
    exit 1
}
"`n结果：全部通过（$checks 项）"
exit 0
