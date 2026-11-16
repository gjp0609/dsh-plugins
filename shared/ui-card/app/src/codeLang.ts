/** 卡片代码块的语言标记：空 / 全空白一律当缺省 `sh`（行的默认语义是「一条要执行的命令」）。 */
export function codeLang(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  return trimmed === '' ? 'sh' : trimmed
}
