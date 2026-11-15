import { clipboard, screen } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScreenRect } from './selectionBounds'

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

/**
 * 读取当前焦点输入框中的文本与屏幕位置（DIP 矩形）
 */
export async function readFocusedInput(ownPid: number): Promise<FocusedInputInfo | null> {
  if (process.platform !== 'win32') return null

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
  if ($proc -match '^(ScreenClippingHost|SnippingTool|Snipaste|PixPin|ShareX|PicPick|Flameshot|FSCapture|obs64|explorer)$') {
    exit 0
  }

  $ct = $el.Current.ControlType.ProgrammaticName
  $isEditableType = $ct -match '(Edit|Document|ComboBox|Text|Custom|Pane)'
  if (-not $isEditableType) { exit 0 }

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
    if ($vp.Current.IsReadOnly) { exit 0 }
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

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      timeout: 2000,
      encoding: 'utf8',
    })
    const line = (stdout || '').trim().split(/\r?\n/).pop() || ''
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
  } catch {
    return null
  }
}

/**
 * 将当前焦点输入框中的中文替换为英文译文（优先使用 ValuePattern，否则自动通过全选粘贴完成并恢复原剪贴板）
 */
export async function replaceFocusedInputText(replacement: string): Promise<boolean> {
  if (process.platform !== 'win32' || !replacement) return false

  const previousImage = clipboard.readImage()
  const hadImageBefore = !previousImage.isEmpty()
  const previousText = clipboard.readText()

  clipboard.writeText(replacement)
  await sleep(30)

  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^a^v")
`
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      timeout: 2500,
    })
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
