/**
 * electron-builder afterSign 钩子（仅 macOS）：用固定的自签名证书重新签名 .app。
 *
 * ad-hoc 签名每次打包的指纹都不同，系统会把新版本当成另一个 App，辅助功能 / 屏幕录制权限随之失效。
 * 改用同一张证书签名后，系统按「Bundle ID + 证书」识别 App，更新后权限依然有效。
 *
 * electron-builder 只认系统信任的证书，自签名证书会被它过滤掉，所以这里自己调用 codesign。
 * 证书导入一个临时钥匙串，签完即删，不改动登录钥匙串和信任设置。
 *
 * 证书来源（按顺序）：
 *   1. MAC_SIGN_P12_BASE64 + MAC_SIGN_PASSWORD（GitHub Actions 的 Secrets）
 *   2. MAC_SIGN_P12（文件路径）+ MAC_SIGN_PASSWORD
 *   3. ~/.englishtools-signing/cert.p12 + password.txt（本地打包）
 * 都没有时保持 ad-hoc 签名并给出提示。
 */
const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

function loadCert() {
  const password = process.env.MAC_SIGN_PASSWORD
  if (process.env.MAC_SIGN_P12_BASE64 && password) {
    return { p12: Buffer.from(process.env.MAC_SIGN_P12_BASE64, 'base64'), password }
  }
  if (process.env.MAC_SIGN_P12 && password) {
    return { p12: fs.readFileSync(process.env.MAC_SIGN_P12), password }
  }
  const dir = path.join(os.homedir(), '.englishtools-signing')
  const p12 = path.join(dir, 'cert.p12')
  const pwd = path.join(dir, 'password.txt')
  if (fs.existsSync(p12) && fs.existsSync(pwd)) {
    return { p12: fs.readFileSync(p12), password: fs.readFileSync(pwd, 'utf8').trim() }
  }
  return null
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const cert = loadCert()
  if (!cert) {
    console.warn('[mac-sign] 未找到自签名证书，保持 ad-hoc 签名（更新后需重新授权权限）')
    return
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'et-sign-'))
  const keychain = path.join(tmp, 'sign.keychain-db')
  const kcPassword = crypto.randomBytes(16).toString('hex')
  const p12File = path.join(tmp, 'cert.p12')
  try {
    fs.writeFileSync(p12File, cert.p12, { mode: 0o600 })
    run('security', ['create-keychain', '-p', kcPassword, keychain])
    run('security', ['set-keychain-settings', keychain])
    run('security', ['unlock-keychain', '-p', kcPassword, keychain])
    run('security', ['import', p12File, '-k', keychain, '-P', cert.password, '-T', '/usr/bin/codesign'])
    // 允许 codesign 直接使用私钥，不弹钥匙串授权框
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', kcPassword, keychain])

    // 自签名证书不受信任，不能加 -v；取第一个代码签名身份的 SHA-1
    const m = run('security', ['find-identity', '-p', 'codesigning', keychain]).match(/\b([0-9A-F]{40})\b/)
    if (!m) throw new Error('证书里没有可用于代码签名的身份')
    const identity = m[1]

    const sign = (target, extra = []) =>
      run('codesign', ['--force', '--sign', identity, '--keychain', keychain, '--timestamp=none', ...extra, target])

    // 先签内层的输入监听辅助程序，再整体签名 .app（--deep 覆盖 Electron 自带的 Frameworks / Helper）
    const helper = path.join(appPath, 'Contents', 'Resources', 'native', 'bin', 'mac-input-tap')
    if (fs.existsSync(helper)) sign(helper, ['--identifier', 'com.englishtools.mac-input-tap'])
    sign(appPath, ['--deep'])
    run('codesign', ['--verify', '--deep', '--strict', appPath])
    console.log(`[mac-sign] 已用自签名证书签名 ${path.basename(appPath)} (${path.basename(context.appOutDir)})`)
  } finally {
    try {
      run('security', ['delete-keychain', keychain])
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
