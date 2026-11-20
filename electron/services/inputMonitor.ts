import { clipboard, screen } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScreenRect } from './selectionBounds'
import { macProbeFocusedInput, macSendCommandKeys, macSendKeys } from './macAutomation'
import { copySelectionPreservingClipboard } from './clipboard'
import { macReadInputByOcr } from './macScreenOcr'
import { diag, diagEnabled } from './diag'

/**
 * macOS 上读不到无障碍信息的聊天应用：自动打字检测时改为截屏识别输入框（不发按键、不碰剪贴板）。
 * 微信 4.x 是 Qt 自绘界面，窗口里只暴露了红绿灯三个按钮。
 */
const MAC_OCR_BUNDLES = new Set(['com.tencent.xinWeChat'])

const execFileAsync = promisify(execFile)

export interface FocusedInputInfo {
  text: string
  rect: ScreenRect
  isFullValue: boolean
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function toDipRect(phys: ScreenRect): ScreenRect {
  try {
    const tl = screen.screenToDipPoint({
      x: Math.round(phys.x),
      y: Math.round(phys.y),
    })
    const br = screen.screenToDipPoint({
      x: Math.round(phys.x + phys.width),
      y: Math.round(phys.y + phys.height),
    })
    return {
      x: Math.min(tl.x, br.x),
      y: Math.min(tl.y, br.y),
      width: Math.max(1, Math.abs(br.x - tl.x)),
      height: Math.max(1, Math.abs(br.y - tl.y)),
    }
  } catch {
    const factor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor || 1
    return {
      x: phys.x / factor,
      y: phys.y / factor,
      width: Math.max(1, phys.width / factor),
      height: Math.max(1, phys.height / factor),
    }
  }
}

export interface ReadInputOptions {
  /**
   * 无障碍接口读不到内容时，允许用「全选 → 复制 → → 键取消全选」读取整段输入（会恢复剪贴板）。
   * 只在用户主动按快捷键时开启；自动打字检测绝不发按键。
   */
  allowClipboard?: boolean
  /** 最后一键可能仍在输入法组合中：屏幕上还是拼音，截屏识别没有意义 */
  maybeComposing?: boolean
}

const DEBUG = !!(process.env.VITE_DEV_SERVER_URL || process.env.ENGLISHTOOLS_DEBUG)

function cursorRect(): ScreenRect {
  const cur = screen.getCursorScreenPoint()
  return { x: cur.x, y: cur.y, width: 40, height: 24 }
}

/** 全选 → 复制 → 右方向键（取消全选，光标落在末尾），读取整段输入并恢复剪贴板 */
async function copyWholeInput(): Promise<string> {
  if (process.platform === 'darwin') {
    return copySelectionPreservingClipboard(() => macSendKeys('cmd:a', 'cmd:c', 'right'))
  }
  if (process.platform === 'win32') {
    return copySelectionPreservingClipboard(async () => {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^a^c{RIGHT}")
`
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
        windowsHide: true,
        timeout: 2500,
      })
    })
  }
  return ''
}

/**
 * 读取当前焦点输入框中的文本与屏幕位置（DIP 矩形）
 */
export async function readFocusedInput(
  ownPid: number,
  opts: ReadInputOptions = {},
): Promise<FocusedInputInfo | null> {
  if (process.platform === 'darwin') return readFocusedInputMac(ownPid, opts)
  if (process.platform !== 'win32') return null
  // 自动打字检测不支持微信（Qt 自绘输入框，UIA 读不到内容）；手动快捷键仍可通过复制读取
  const info = await readFocusedInputWin(ownPid, !opts.allowClipboard)
  if (info?.text || !opts.allowClipboard) return info
  const text = await copyWholeInput()
  if (DEBUG) console.log(`[input] clipboard fallback len=${text.length}`)
  if (!text) return null
  return { text, rect: info?.rect ?? cursorRect(), isFullValue: true }
}

/** Windows 版微信的进程名（4.x 为 Weixin，3.x 为 WeChat） */
const WIN_WECHAT_PROCS = 'Weixin|WeChat|WeChatAppEx'

async function readFocusedInputWin(
  ownPid: number,
  skipWeChat: boolean,
): Promise<FocusedInputInfo | null> {
  const skipProcs = `ScreenClippingHost|SnippingTool|Snipaste|PixPin|ShareX|PicPick|Flameshot|FSCapture|obs64|explorer${
    skipWeChat ? `|${WIN_WECHAT_PROCS}` : ''
  }`

  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DpiCtxInput { [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value); }' -ErrorAction SilentlyContinue
  [void][DpiCtxInput]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms

try {
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $el) { exit 0 }

  $pidVal = $el.Current.ProcessId
  if ($pidVal -eq ${ownPid}) { exit 0 }

  $proc = (Get-Process -Id $pidVal -ErrorAction SilentlyContinue).ProcessName
  if ($proc -match '^(${skipProcs})$') {
    Write-Output ('__SKIP__:proc=' + $proc)
    exit 0
  }

  $ct = $el.Current.ControlType.ProgrammaticName
  $isEditableType = $ct -match '(Edit|Document|ComboBox|Text|Custom|Pane)'
  if (-not $isEditableType) {
    Write-Output ('__SKIP__:proc=' + $proc + ' type=' + $ct)
    exit 0
  }

  $elRect = $el.Current.BoundingRectangle
  $text = ''
  $isFullValue = $true
  $caretX = [double]::NaN
  $caretY = [double]::NaN
  $caretW = [double]::NaN
  $caretH = [double]::NaN

  # 1. 优先尝试 ValuePattern（绝大多数单行/多行输入框、浏览器 input/textarea、微信/飞书输入框）
  $vp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    if ($vp.Current.IsReadOnly) {
      Write-Output ('__SKIP__:proc=' + $proc + ' type=' + $ct + ' readonly')
      exit 0
    }
    $text = $vp.Current.Value
    $isFullValue = $true
  }

  # 2. 尝试 TextPattern（富文本编辑器、contenteditable、Word、记事本等）
  $tp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
    $sel = $tp.GetSelection()
    if ($sel -and $sel.Length -gt 0) {
      $caretRects = $sel[0].GetBoundingRectangles()
      if ($caretRects -and $caretRects.Length -ge 4) {
        $caretX = [double]$caretRects[0]
        $caretY = [double]$caretRects[1]
        $caretW = [double]$caretRects[2]
        $caretH = [double]$caretRects[3]
      }
      if ([string]::IsNullOrWhiteSpace($text)) {
        $para = $sel[0].Clone()
        $para.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Paragraph)
        $paraText = $para.GetText(600)
        if (-not [string]::IsNullOrWhiteSpace($paraText)) {
          $text = $paraText
          $isFullValue = $false
        }
        if ([double]::IsNaN($caretX)) {
          $pRects = $para.GetBoundingRectangles()
          if ($pRects -and $pRects.Length -ge 4) {
            $caretX = [double]$pRects[0]
            $caretY = [double]$pRects[1]
            $caretW = [double]$pRects[2]
            $caretH = [double]$pRects[3]
          }
        }
      }
    }
    if ([string]::IsNullOrWhiteSpace($text) -and $ct -match 'Edit') {
      $text = $tp.DocumentRange.GetText(600)
      $isFullValue = $true
    }
  }

  if ($null -eq $text) { $text = '' }
  $text = $text.Trim()

  $rx = $elRect.Left
  $ry = $elRect.Top
  $rw = $elRect.Width
  $rh = $elRect.Height

  if (-not [double]::IsNaN($caretX) -and $caretH -gt 0) {
    $rx = $caretX
    $ry = $caretY
    $rw = [Math]::Max(20, $caretW)
    $rh = [Math]::Max(20, $caretH)
  } elseif ($rh -gt 90) {
    # 对于较高的多行聊天输入框（如微信底部输入区），将锚点放在输入区顶部第一行下方，避免跑出屏幕底部
    $rh = 34
  }

  $out = @{
    proc = $proc
    ctype = $ct
    ok = $true
    text = $text
    isFullValue = $isFullValue
    x = $rx
    y = $ry
    width = $rw
    height = $rh
  }
  Write-Output ($out | ConvertTo-Json -Compress)
} catch {}
`

  const t0 = Date.now()
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      timeout: 2000,
      encoding: 'utf8',
    })
    const line = (stdout || '').trim().split(/\r?\n/).pop() || ''
    if (diagEnabled()) {
      let info: Record<string, unknown> = { result: line.startsWith('__SKIP__') ? line : line ? 'json' : 'empty' }
      if (line.startsWith('{')) {
        try {
          const j = JSON.parse(line) as { proc?: string; ctype?: string; text?: string }
          info = { result: 'ok', proc: j.proc, ctype: j.ctype, len: (j.text || '').length }
        } catch {
          /* ignore */
        }
      }
      diag('type', { step: 'uia-probe', ms: Date.now() - t0, ...info })
    }
    if (!line.startsWith('{')) return null
    const parsed = JSON.parse(line) as {
      ok?: boolean
      text?: string
      isFullValue?: boolean
      x?: number
      y?: number
      width?: number
      height?: number
    }
    if (!parsed.ok) return null

    let dipRect: ScreenRect
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y) &&
      (parsed.width ?? 0) > 0 &&
      (parsed.height ?? 0) > 0
    ) {
      dipRect = toDipRect({
        x: parsed.x,
        y: parsed.y,
        width: parsed.width || 60,
        height: parsed.height || 24,
      })
    } else {
      const cur = screen.getCursorScreenPoint()
      dipRect = { x: cur.x, y: cur.y, width: 40, height: 24 }
    }

    return {
      text: (parsed.text || '').trim(),
      rect: dipRect,
      isFullValue: parsed.isFullValue !== false,
    }
  } catch (err) {
    diag('type', { step: 'uia-probe-failed', ms: Date.now() - t0, err: String(err).slice(0, 200) })
    return null
  }
}

/**
 * 将当前焦点输入框中的中文替换为英文译文（优先使用 ValuePattern，否则自动通过全选粘贴完成并恢复原剪贴板）
 */
async function readFocusedInputMac(
  ownPid: number,
  opts: ReadInputOptions,
): Promise<FocusedInputInfo | null> {
  const probe = await macProbeFocusedInput(ownPid)
  diag('type', {
    step: 'ax-probe',
    status: probe.status,
    app: probe.app,
    bundleId: probe.bundleId,
    role: probe.role || '-',
    len: probe.status === 'error' ? undefined : probe.text.length,
    hasRect: !!probe.rect,
    err: probe.status === 'error' ? probe.text.slice(0, 200) : undefined,
  })
  if (probe.status === 'own' || probe.status === 'secure' || probe.status === 'error') return null

  let text = probe.status === 'ok' ? probe.text : ''
  let rect = probe.status === 'ok' ? probe.rect : null

  if (!text && opts.allowClipboard) {
    text = await copyWholeInput()
    if (DEBUG) console.log(`[input] clipboard fallback len=${text.length}`)
    rect = null
  } else if (
    !text &&
    probe.status === 'nofocus' &&
    probe.windowRect &&
    MAC_OCR_BUNDLES.has(probe.bundleId)
  ) {
    if (opts.maybeComposing) return null
    const ocr = await macReadInputByOcr(probe.windowRect, DEBUG)
    if (!ocr) return null
    // 识别到空输入框（如消息刚发出）也返回，让调用方收起旧卡片
    return { text: ocr.text, rect: ocr.anchor, isFullValue: true }
  }
  if (!text && probe.status !== 'ok') return null

  if (rect) {
    // 较高的多行输入区（聊天框、文档），锚点放在第一行附近，避免跑出屏幕底部
    if (rect.height > 90) rect = { ...rect, height: 34 }
  } else if (probe.windowRect) {
    // 拿不到控件位置（如微信）：聊天应用的输入区在窗口底部，贴着窗口底边显示（放不下时自动翻到上方）
    const w = probe.windowRect
    rect = { x: w.x + Math.round(w.width * 0.3), y: w.y + w.height - 8, width: 40, height: 8 }
  } else {
    rect = cursorRect()
  }
  // macOS 的 AX 坐标就是全局点坐标，与 Electron DIP 一致，无需换算
  return { text, rect, isFullValue: true }
}

export async function replaceFocusedInputText(replacement: string): Promise<boolean> {
  if (!replacement) return false
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false

  const previousImage = clipboard.readImage()
  const hadImageBefore = !previousImage.isEmpty()
  const previousText = clipboard.readText()

  clipboard.writeText(replacement)
  await sleep(30)

  try {
    if (process.platform === 'darwin') {
      await macSendCommandKeys('a', 'v')
    } else {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^a^v")
`
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
        windowsHide: true,
        timeout: 2500,
      })
    }
  } catch {
    return false
  }

  await sleep(140)

  if (hadImageBefore) {
    clipboard.writeImage(previousImage)
  } else {
    clipboard.writeText(previousText)
  }

  return true
}
