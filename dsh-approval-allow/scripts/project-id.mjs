#!/usr/bin/env node
/**
 * 从项目路径算出审批白名单的项目标识，并打印唯一配置文件的路径。
 *
 * 用法：
 *   node dsh-approval-allow/scripts/project-id.mjs "C:\work\dsh-plugins"
 *
 * 输出与插件运行时完全同源：都调用 lib/config.mjs 的 projectIdFor。
 */
import { join } from 'node:path'
import { projectIdFor, resolveDataDir } from '../lib/config.mjs'

const root = process.argv.slice(2).join(' ').trim()
if (root === '') {
  console.error('用法: node dsh-approval-allow/scripts/project-id.mjs "<项目绝对路径>"')
  process.exit(1)
}

const id = projectIdFor(root)
if (id === null) {
  console.error(`无法计算：${JSON.stringify(root)} 不是绝对路径。`)
  process.exit(1)
}

const file = join(resolveDataDir({}), 'allow.json')
console.log(`projectId: ${id}`)
console.log(`配置文件: ${file}`)
console.log(`把项目规则写进 projects["${id}"]`)
