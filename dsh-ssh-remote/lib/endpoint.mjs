/**
 * 端点 IO：把「远端主机」与「WSL 发行版」抹平成同一套接口。
 *
 * 为什么这么做：搬运只有两种原件——「跑一条命令拿文本」和「开一条带 stdin/stdout 的字节流」。
 * 远端用 ssh exec（ssh2 的 Channel 本身就是双向流），WSL 用 `wsl.exe -- sh -c`（stdin/stdout 都 pipe）。
 * 于是四种组合（远端↔远端、远端↔WSL、WSL↔WSL）共用同一条中继，不需要 SFTP、不落本地磁盘。
 *
 * 代价（有意接受）：要求对端有 POSIX sh + tar + cat，也就是任何 Linux/macOS 服务器与本机 WSL。
 * 换来的好处：没有 SFTP 子系统依赖（很多服务器默认关掉 sftp-server）、没有本地临时文件、语义只有一套。
 */
const MAX_STDERR_BYTES = 4096

/** 把一段可能很吵的 stderr 压成尾部这么多字节。 */
export function tailText(text, limit = MAX_STDERR_BYTES) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return value.slice(value.length - limit)
}

/**
 * WSL 侧 spawn 句柄 → 统一句柄。
 * `handle.done` 失败也要转成 outcome，不然调用方得为两种失败形态写两套分支。
 */
function wrapWslHandle(handle) {
  const chunks = []
  let size = 0
  handle.stderr?.on('data', (chunk) => {
    if (size >= MAX_STDERR_BYTES) return
    chunks.push(chunk)
    size += chunk.length
  })

  const done = Promise.resolve(handle.done).then(
    (outcome) => ({
      exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
      signalName: outcome?.signal ?? null,
      stderr: tailText(Buffer.concat(chunks).toString('utf8')),
    }),
    (error) => ({ exitCode: null, signalName: null, stderr: `WSL 进程失败：${error?.message ?? error}` }),
  )

  return {
    stdout: handle.stdout ?? null,
    stdin: handle.stdin ?? null,
    done,
    kill() {
      try {
        handle.terminate()
      } catch {
        // 已经退了
      }
    },
    release() {},
  }
}

/**
 * @param pool - 见 lib/pool.mjs（需要 `run` 与 `channels`）
 * @param wsl - 见 lib/wsl.mjs（需要 `run` 与 `openPipe`）
 */
export function createEndpointIO({ pool, wsl }) {
  return {
    /** 跑一条命令并收集文本输出（预检、mv、清理都用它）。 */
    async runText(target, command, { timeoutMs, signal } = {}) {
      if (target.kind === 'wsl') {
        const outcome = await wsl.run(target.distro, command, { timeoutMs, signal, maxBytes: 64 * 1024 })
        return { ...outcome, stderr: tailText(outcome.stderr) }
      }
      return await pool.run(target, command, { timeoutMs, signal })
    },

    /**
     * 打开一条或多条字节流通道。
     *
     * **同一台远端主机必须一次要齐**：连接池按主机串行排队，分两次取会自己把自己堵死
     * （第二次数不到队尾，因为第一次的槽位还在）。
     * @param keepStdin - 仅对 WSL 有意义：true 表示 stdin 留给数据（脚本改走临时文件）
     */
    async openMany(target, commands, { signal, keepStdin = false } = {}) {
      if (target.kind === 'wsl') {
        return commands.map((command) => wrapWslHandle(wsl.openPipe(target.distro, command, { signal, keepStdin })))
      }
      return await pool.channels(target, commands, { signal })
    },
  }
}
