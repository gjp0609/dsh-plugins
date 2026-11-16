/**
 * 剪贴板里该放什么（B-32）：只放**命令本体**。
 *
 * 卡片上的代码框里，框内第一行（或前几行）是说明，现在由 `highlight.ts` 拼成 `# 说明`
 * 与命令进**同一段源码**（`source = '# 说明\n' + 命令`，D-42），所以框里本来就混着两类东西：
 * 这些 `#` 开头的说明行、以及命令本身可能自带的整行注释。复制时把整行注释都去掉——
 * 粘到终端里它们只是噪音，粘到别处还可能被当成命令的一部分。
 *
 * 调用方传进来的是 `commandOnly(block.command)` / `commandOnly(row.text)`，说明字段根本没进去；
 * 这里的剥离是第二道保证：万一将来有人把整段 source 递进来，`#` 行也不会进剪贴板。
 *
 * 只认「行首（允许缩进）就是 #」，行尾的行内注释（`cmd --x  # 备注`）**不动**：
 * 那是 shell 语法的一部分，删掉会改变命令语义。
 *
 * 纯函数、没有依赖：断言直接喂字符串比对（`tests/card-shell.ps1`）。
 */
export function commandOnly(text: string): string {
  const kept = text.split('\n').filter((line) => !/^\s*#/.test(line))
  while (kept.length > 0 && kept[0].trim() === '') kept.shift()
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  return kept.join('\n')
}
