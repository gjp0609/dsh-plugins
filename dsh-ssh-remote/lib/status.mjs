/**
 * `ssh_status`：只读的体检报告——主机清单、连接状态、vault 状态、热加载情况。
 * 不需要审批（不碰任何远端），也永远不返回密码。
 */
export function createStatusTool({ store, pool, dataDir }) {
  return {
    name: 'ssh_status',
    description:
      '查看 SSH 插件当前状态：配置了哪些主机与 WSL 发行版、哪些有密码、连接是否已建立/延迟多少、vault 是否可用、配置最后什么时候重载。不连接服务器、不做任何修改。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          lines: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'lines'],
        additionalProperties: false,
      },
      render(_args, value) {
        const warnings = Array.isArray(value?.warnings) ? value.warnings : []
        return [
          {
            type: 'text',
            text: [...value.lines.map((line) => `- ${line}`), ...warnings.map((line) => `⚠ ${line}`)].join('\n'),
          },
        ]
      },
    },
    async execute() {
      const snapshot = await store.ensureLoaded()
      const connections = new Map(pool.status().map((item) => [item.hostId, item]))
      const lines = []

      lines.push(`数据目录：${dataDir}`)
      lines.push(
        `配置：第 ${snapshot.revision} 次读取，${snapshot.lastReloadAt ?? '尚未读取'}` +
          `（改 hosts.json / config.json / 密码文件后自动生效，无需重启 DSH）`,
      )

      const hosts = Object.values(snapshot.hosts)
      if (hosts.length === 0) lines.push('远程主机：还没有配置（到插件设置页「SSH 主机」里添加）')
      for (const host of hosts) {
        const connection = connections.get(host.id)
        const stateText =
          connection === undefined
            ? '未连接'
            : connection.state === 'ready'
              ? `已连接（握手 ${connection.connectedMs ?? '?'}ms，空闲 ${Math.round((connection.idleMs ?? 0) / 1000)}s）`
              : connection.state === 'connecting'
                ? '连接中'
                : `未连接${connection.lastError === null ? '' : `（${connection.lastError}）`}`
        const passwordText = snapshot.vault.usable
          ? store.vault.has(host.id)
            ? '密码已保存'
            : host.via === undefined
              ? '⚠ 无密码'
              : '凭据已接入'
          : '⚠ 密码库不可用'
        lines.push(
          `${host.id}  ${host.user}@${host.address}:${host.port}  ${host.label}` +
            `${host.tags.length === 0 ? '' : `  [${host.tags.join(', ')}]`}  ${passwordText}  ${stateText}`,
        )
      }

      const distros = Object.values(snapshot.wsl)
      if (distros.length === 0) lines.push('WSL：还没有配置发行版（在 hosts.json 的 wsl 段里加）')
      for (const item of distros) {
        lines.push(`wsl:${item.distro}  ${item.label}  （本机 WSL，命令走 wsl.exe，不用密码）`)
      }

      const vault = snapshot.vault
      lines.push(
        `密码库：${vault.state}${vault.usable ? '' : '（已 fail closed，不会连接任何主机）'}，` +
          `${vault.count} 条${vault.cipherBytes === null ? '' : `，密文 ${vault.cipherBytes} 字节`}，最后读取 ${vault.loadedAt ?? '—'}`,
      )
      if (vault.error !== null) lines.push(`密码库错误：${vault.error}`)

      const settings = snapshot.settings
      lines.push(
        `设置：超时 ${settings.stepTimeoutMs}ms，连接超时 ${settings.connectTimeoutMs}ms，` +
          `空闲关闭 ${Math.round(settings.idleTimeoutMs / 1000)}s，最多 ${settings.maxConnections} 条连接，卡片最多 ${settings.maxCardRows} 行`,
      )

      if (snapshot.lastError !== null) lines.push(`最近的错误：${snapshot.lastError}`)

      return { ok: snapshot.lastError === null && snapshot.vault.usable, lines, warnings: snapshot.warnings }
    },
  }
}
