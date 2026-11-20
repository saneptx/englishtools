import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 排查用诊断日志：在数据目录放一个 debug.flag 文件（或设置 ENGLISHTOOLS_DEBUG 环境变量）即开启，
 * 记录划词 / 打字检测每一步的结果和耗时，写到数据目录 logs/diag.log（超过 1MB 轮转一次）。
 * 只记录长度、状态、应用名等，不记录选中或输入的文字内容。
 */

let enabled: boolean | null = null
let file = ''

export function diagEnabled(): boolean {
  if (enabled === null) {
    const dir = app.getPath('userData')
    enabled = !!(process.env.VITE_DEV_SERVER_URL || process.env.ENGLISHTOOLS_DEBUG) || existsSync(join(dir, 'debug.flag'))
    if (enabled) {
      mkdirSync(join(dir, 'logs'), { recursive: true })
      file = join(dir, 'logs', 'diag.log')
    }
  }
  return enabled
}

export function diag(tag: string, data: Record<string, unknown> = {}): void {
  if (!diagEnabled()) return
  const line = `${new Date().toISOString()} [${tag}] ${JSON.stringify(data)}\n`
  console.log(line.trimEnd())
  try {
    if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`)
    appendFileSync(file, line)
  } catch {
    /* ignore */
  }
}
