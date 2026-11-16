/**
 * 部分环境下 electron postinstall 解压不完整（缺 path.txt、缺二进制，
 * 或 macOS 上缺 Electron Framework——extract-zip 处理 .app 内符号链接会失败）时自动修复：
 * 先重跑 install.js，仍不完整则从本地缓存 zip 用系统工具解压
 * （Windows: Expand-Archive，macOS: ditto，Linux: unzip）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync, execFileSync } = require('child_process')

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
const distDir = path.join(electronDir, 'dist')
const pathTxt = path.join(electronDir, 'path.txt')

const PLATFORM_BIN = {
  win32: 'electron.exe',
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
}
const binRel = PLATFORM_BIN[process.platform]
if (!binRel || !fs.existsSync(electronDir)) {
  process.exit(0)
}

function binaryComplete() {
  if (!fs.existsSync(path.join(distDir, binRel))) return false
  if (process.platform === 'darwin') {
    return fs.existsSync(
      path.join(
        distDir,
        'Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework',
      ),
    )
  }
  return true
}

function done(msg) {
  fs.writeFileSync(pathTxt, binRel)
  if (msg) console.log(`[ensure-electron] ${msg}`)
  process.exit(0)
}

if (binaryComplete()) {
  if (fs.existsSync(pathTxt)) process.exit(0)
  done('wrote missing path.txt')
}

console.log('[ensure-electron] repairing electron binary…')
try {
  execSync('node install.js', { cwd: electronDir, stdio: 'inherit', env: process.env })
} catch {
  /* fall through to cache extract */
}
if (binaryComplete()) done('repaired via install.js')

const cacheRoot =
  process.env.electron_config_cache ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'electron')
      : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron'))

if (!fs.existsSync(cacheRoot)) {
  console.warn('[ensure-electron] no cache found; run: npm rebuild electron')
  process.exit(0)
}

const { version } = require(path.join(electronDir, 'package.json'))
const zipName = `electron-v${version}-${process.platform}-${process.arch}.zip`

function findZip(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      const hit = findZip(full)
      if (hit) return hit
    } else if (name === zipName) {
      return full
    }
  }
  return null
}

const zip = findZip(cacheRoot)
if (!zip) {
  console.warn(`[ensure-electron] ${zipName} not in cache`)
  process.exit(0)
}

fs.rmSync(distDir, { recursive: true, force: true })
fs.mkdirSync(distDir, { recursive: true })
if (process.platform === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${distDir.replace(/'/g, "''")}' -Force"`,
    { stdio: 'inherit' },
  )
} else if (process.platform === 'darwin') {
  execFileSync('ditto', ['-x', '-k', zip, distDir], { stdio: 'inherit' })
} else {
  execFileSync('unzip', ['-q', '-o', zip, '-d', distDir], { stdio: 'inherit' })
}

if (binaryComplete()) done('repaired from cache')
console.warn('[ensure-electron] repair failed; delete node_modules/electron and reinstall')
