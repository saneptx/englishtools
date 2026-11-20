import { clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { macProbeSelection, macSendCommandKeys } from './macAutomation'
import { diag } from './diag'

const execFileAsync = promisify(execFile)

const SENTINEL = '__ENGLISHTOOLS_CLIP_SENTINEL__'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 安全获取当前划词文本：
 * 1. 松手瞬间不读写剪贴板（不争抢 OpenClipboard 锁），先通过 PowerShell 检查当前焦点窗口与 UI Automation；
 * 2. 若当前处于截图工具（Win+Shift+S、微信/QQ/钉钉/飞书截图遮罩、Snipaste、PixPin、ShareX 等）或桌面文件列表，直接中止；
 * 3. 若焦点控件支持 UIA TextPattern 且已有选中文本，直接返回文本（全程零剪贴板操作、不发 Ctrl+C）；
 * 4. 仅在普通窗口需要回退 Ctrl+C 时才发送 ^c，且绝不清空或覆盖剪贴板中的图片。
 */
export async function captureSelectedText(): Promise<string> {
  if (process.platform === 'darwin') return captureSelectedTextMac()
  if (process.platform === 'linux') {
    // X11/部分 Wayland 下选中即进入 PRIMARY 选区，无需模拟复制
    return clipboard.readText('selection').trim()
  }
  if (process.platform !== 'win32') return ''

  const probePs = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, UIAutomationClient, UIAutomationTypes, WindowsBase
$proc = ''
try {
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -ne $el) {
    $pidVal = $el.Current.ProcessId
    $proc = (Get-Process -Id $pidVal -ErrorAction SilentlyContinue).ProcessName
    if ($proc -match '^(ScreenClippingHost|SnippingTool|Snipaste|PixPin|ShareX|PicPick|Flameshot|FSCapture|obs64)$') {
      Write-Output '__ABORT__'
      exit 0
    }
    $cls = $el.Current.ClassName
    if ($cls -match '^(Progman|WorkerW|SysListView32|DirectUIHWND|Shell_TrayWnd|SnapshotWnd|ScreenCapture)$') {
      Write-Output '__ABORT__'
      exit 0
    }
    $rect = $el.Current.BoundingRectangle
    $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $ct = $el.Current.ControlType.ProgrammaticName
    if ($rect.Width -ge ($scr.Width - 2) -and $rect.Height -ge ($scr.Height - 2) -and $ct -notmatch 'Document|Edit') {
      Write-Output '__ABORT__'
      exit 0
    }
    $tp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $sel = $tp.GetSelection()
      if ($sel -and $sel.Length -gt 0) {
        $t = $sel[0].GetText(2000)
        if ($t -and $t.Trim().Length -gt 0) {
          Write-Output ("__UIA__:" + $t.Trim())
          exit 0
        }
      }
    }
  }
} catch {}
Write-Output ('__NEED_COPY__:' + $proc)
`

  let probeOut = ''
  const t0 = Date.now()
  try {
    const res = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', probePs], {
      windowsHide: true,
      timeout: 2500,
      encoding: 'utf8',
    })
    probeOut = (res.stdout || '').trim()
  } catch (err) {
    diag('select', { step: 'uia-probe-failed', ms: Date.now() - t0, err: String(err).slice(0, 200) })
    return ''
  }
  diag('select', {
    step: 'uia-probe',
    result: probeOut.split(':')[0].slice(0, 20),
    proc: probeOut.startsWith('__NEED_COPY__:') ? probeOut.slice(14, 60) : undefined,
    ms: Date.now() - t0,
  })

  if (!probeOut || probeOut.startsWith('__ABORT__')) {
    return ''
  }

  if (probeOut.startsWith('__UIA__:')) {
    return probeOut.slice('__UIA__:'.length).trim()
  }

  // 仅当 UIA 未能直接读出文本且确认不是截图工具时，才走非破坏性 Ctrl+C 回退
  return copySelectionPreservingClipboard(async () => {
    const copyPs = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^c")
`
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', copyPs], {
      windowsHide: true,
      timeout: 2500,
    })
  })
}

/** macOS：先读 AXSelectedText（零剪贴板操作），读不到再回退 Cmd+C */
async function captureSelectedTextMac(): Promise<string> {
  const t0 = Date.now()
  const probe = await macProbeSelection()
  diag('select', { step: 'ax-probe', kind: probe.kind, app: 'app' in probe ? probe.app : undefined, ms: Date.now() - t0 })
  if (probe.kind === 'abort') return ''
  if (probe.kind === 'text') return probe.text
  return copySelectionPreservingClipboard(() => macSendCommandKeys('c'))
}

/**
 * 发送系统复制快捷键读取选区，读完恢复原剪贴板；剪贴板里是图片时绝不清空或覆盖。
 */
export async function copySelectionPreservingClipboard(sendCopy: () => Promise<void>): Promise<string> {
  const previousImage = clipboard.readImage()
  const hadImageBefore = !previousImage.isEmpty()
  const previousText = clipboard.readText()

  // 如果剪贴板里当前是图片，绝不清空或写入哨兵，保护用户的截图剪贴板
  let wroteSentinel = false
  if (!hadImageBefore) {
    clipboard.writeText(SENTINEL)
    wroteSentinel = true
  }

  const restorePreviousTextIfNeeded = () => {
    if (!wroteSentinel) return
    if (!clipboard.readImage().isEmpty()) return
    if (clipboard.readText() === SENTINEL) {
      clipboard.writeText(previousText)
    }
  }

  const t0 = Date.now()
  try {
    await sendCopy()
  } catch (err) {
    diag('copy', { step: 'send-failed', ms: Date.now() - t0, err: String(err).slice(0, 200) })
    restorePreviousTextIfNeeded()
    return ''
  }

  await sleep(100)

  // 如果此时剪贴板里仍然是图片（说明 ^c 没有复制出任何文本，或刚被截图工具写入了图片），绝不改动剪贴板
  if (!clipboard.readImage().isEmpty()) {
    diag('copy', { step: 'image-on-clipboard', hadImageBefore })
    return ''
  }

  const rawAfter = clipboard.readText()
  if (!rawAfter || rawAfter === SENTINEL) {
    diag('copy', { step: 'nothing-copied', ms: Date.now() - t0 })
    restorePreviousTextIfNeeded()
    return ''
  }
  diag('copy', { step: 'ok', len: rawAfter.length, ms: Date.now() - t0 })

  const selected = rawAfter.trim()

  if (hadImageBefore) {
    clipboard.writeImage(previousImage)
  } else {
    clipboard.writeText(previousText)
  }

  return selected
}
