/**
 * macOS：编译只读全局输入监听辅助程序 native/mac-input-tap.swift。
 * 输出 arm64 + x86_64 通用二进制（Intel 版 dmg 也能用），最低支持 macOS 13（再低需要 Swift 兼容库，部分工具链缺 x86_64 版本）。
 * 需要 Xcode 命令行工具（xcode-select --install）。其他平台跳过。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

if (process.platform !== 'darwin') process.exit(0)

const root = path.join(__dirname, '..')
const src = path.join(root, 'native', 'mac-input-tap.swift')
const out = path.join(root, 'native', 'bin', 'mac-input-tap')
const MIN_MACOS = '13.0'

function isUniversal(file) {
  try {
    const archs = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' })
    return archs.includes('arm64') && archs.includes('x86_64')
  } catch {
    return false
  }
}

if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs && isUniversal(out)) {
  process.exit(0)
}

fs.mkdirSync(path.dirname(out), { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-input-tap-'))
try {
  const parts = ['arm64', 'x86_64'].map((arch) => {
    const file = path.join(tmp, arch)
    execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macos${MIN_MACOS}`, '-o', file, src], {
      stdio: 'inherit',
    })
    return file
  })
  execFileSync('lipo', ['-create', '-output', out, ...parts], { stdio: 'inherit' })
  console.log('[build-mac-helper] built universal native/bin/mac-input-tap')
} catch {
  console.warn('[build-mac-helper] swiftc 编译失败：请先安装 Xcode 命令行工具（xcode-select --install），然后运行 npm run build:mac-helper')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
