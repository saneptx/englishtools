import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DpiCtx { [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value); }'
[void][DpiCtx]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$el = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $el) { exit 2 }
try {
  $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
} catch { exit 3 }
$ranges = $tp.GetSelection()
if ($null -eq $ranges -or $ranges.Length -eq 0) { exit 4 }
$rects = $ranges[0].GetBoundingRectangles()
if ($null -eq $rects -or $rects.Length -lt 4) { exit 5 }
$minX = [double]::MaxValue
$minY = [double]::MaxValue
$maxR = [double]::MinValue
$maxB = [double]::MinValue
$any = $false
for ($i = 0; $i -lt $rects.Length; $i += 4) {
  $x = [double]$rects[$i]
  $y = [double]$rects[$i + 1]
  $w = [double]$rects[$i + 2]
  $h = [double]$rects[$i + 3]
  if ($w -le 0 -or $h -le 0) { continue }
  $any = $true
  if ($x -lt $minX) { $minX = $x }
  if ($y -lt $minY) { $minY = $y }
  if (($x + $w) -gt $maxR) { $maxR = $x + $w }
  if (($y + $h) -gt $maxB) { $maxB = $y + $h }
}
if (-not $any) { exit 5 }
Write-Output ('{0},{1},{2},{3}' -f $minX, $minY, ($maxR - $minX), ($maxB - $minY))
`

/** 读取当前焦点控件里选中文字的屏幕矩形（物理像素） */
export async function readSelectionRect(): Promise<ScreenRect | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', SCRIPT],
      { timeout: 1500, windowsHide: true },
    )
    const line = stdout.trim().split(/\r?\n/).pop() || ''
    const parts = line.split(',').map((n) => Number(n))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
    const [x, y, width, height] = parts
    if (width < 1 || height < 1) return null
    return { x, y, width, height }
  } catch {
    return null
  }
}
