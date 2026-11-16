/**
 * macOS：编译只读全局输入监听辅助程序 native/mac-input-tap.swift。
 * 需要 Xcode 命令行工具（xcode-select --install）。其他平台跳过。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

if (process.platform !== 'darwin') process.exit(0)

const root = path.join(__dirname, '..')
const src = path.join(root, 'native', 'mac-input-tap.swift')
const out = path.join(root, 'native', 'bin', 'mac-input-tap')

if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) process.exit(0)

fs.mkdirSync(path.dirname(out), { recursive: true })
try {
  execFileSync('swiftc', ['-O', '-o', out, src], { stdio: 'inherit' })
  console.log('[build-mac-helper] built native/bin/mac-input-tap')
} catch {
  console.warn('[build-mac-helper] swiftc 编译失败：请先安装 Xcode 命令行工具（xcode-select --install），然后运行 npm run build:mac-helper')
}
