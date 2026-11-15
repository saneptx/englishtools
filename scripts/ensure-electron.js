/**
 * Windows 下部分环境 electron postinstall 解压不完整时，从缓存补齐二进制。
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
const exe = path.join(electronDir, 'dist', 'electron.exe')
const pathTxt = path.join(electronDir, 'path.txt')

if (process.platform !== 'win32') {
  process.exit(0)
}

if (fs.existsSync(exe) && fs.existsSync(pathTxt)) {
  process.exit(0)
}

console.log('[ensure-electron] repairing electron binary…')
try {
  execSync('node install.js', { cwd: electronDir, stdio: 'inherit', env: process.env })
} catch {
  /* fall through to cache extract */
}

if (fs.existsSync(exe)) {
  fs.writeFileSync(pathTxt, 'electron.exe')
  process.exit(0)
}

const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
if (!fs.existsSync(cacheRoot)) {
  console.warn('[ensure-electron] no cache found; run: npm rebuild electron')
  process.exit(0)
}

const { version } = require(path.join(electronDir, 'package.json'))
const zipName = `electron-v${version}-win32-x64.zip`

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
  console.warn('[ensure-electron] zip not in cache')
  process.exit(0)
}

const dist = path.join(electronDir, 'dist')
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })
execSync(
  `powershell -NoProfile -Command "Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${dist.replace(/'/g, "''")}' -Force"`,
  { stdio: 'inherit' },
)
fs.writeFileSync(pathTxt, 'electron.exe')
console.log('[ensure-electron] repaired from cache')
