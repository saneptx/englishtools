import { nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { visionOcr } from './macScreenOcr'

/**
 * 截图翻译的文字识别，使用系统自带引擎（不再打包 tesseract，安装包小 30 多 MB，识别也更准）：
 * - macOS：Vision 框架
 * - Windows：Windows.Media.Ocr（需要系统装有英文语言包，英文 / 多数中文版 Windows 默认就有）
 */

const execFileAsync = promisify(execFile)

/** macOS：按从上到下、从左到右拼成多行文本 */
async function recognizeMac(pngPath: string): Promise<string> {
  const obs = await visionOcr(pngPath)
  return obs
    .map((o) => ({ text: o.t.trim(), top: 1 - o.y - o.h, left: o.x, h: o.h }))
    .filter((o) => o.text)
    .sort((a, b) => (Math.abs(a.top - b.top) < a.h * 0.5 ? a.left - b.left : a.top - b.top))
    .reduce<{ lines: string[]; lastTop: number; lastH: number }>(
      (acc, o) => {
        // 同一行的片段用空格连接，换行另起
        if (acc.lines.length && Math.abs(o.top - acc.lastTop) < acc.lastH * 0.5) {
          acc.lines[acc.lines.length - 1] += ' ' + o.text
        } else {
          acc.lines.push(o.text)
          acc.lastTop = o.top
          acc.lastH = o.h
        }
        return acc
      },
      { lines: [], lastTop: 0, lastH: 0 },
    )
    .lines.join('\n')
}

/**
 * Windows：Windows PowerShell 5.1 才能加载 WinRT 类型（powershell.exe，不是 pwsh）。
 * WinRT 的异步方法需要用 AsTask 包一层再同步等待。
 */
async function recognizeWindows(pngPath: string): Promise<string> {
  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$lang = [Windows.Globalization.Language]::new('en-US')
if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
} else {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) { Write-Output '__NO_ENGINE__'; exit 0 }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:ET_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
foreach ($line in $result.Lines) { Write-Output $line.Text }
`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true,
    timeout: 20000,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    // 路径用环境变量传入，避免引号 / 特殊字符转义问题
    env: { ...process.env, ET_OCR_IMAGE: pngPath },
  })
  const out = stdout.trim()
  if (out === '__NO_ENGINE__') {
    throw new Error('Windows 未安装可用的 OCR 语言包：请在「设置 → 时间和语言 → 语言」中添加英语')
  }
  return out
}

export async function ocrFromDataUrl(dataUrl: string): Promise<string> {
  let img = nativeImage.createFromDataURL(dataUrl)
  const { width, height } = img.getSize()
  // Windows OCR 要求图片边长在 40~MaxImageDimension(约 2600) 之间，小截图放大后识别率也更高
  if (process.platform === 'win32') {
    const scale = Math.min(Math.max(1, 120 / Math.min(width, height)), 2600 / Math.max(width, height), 3)
    if (scale > 1.05 || scale < 0.95) {
      img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
    }
  }
  const tmp = join(tmpdir(), `englishtools-ocr-${Date.now()}.png`)
  try {
    await writeFile(tmp, img.toPNG())
    if (process.platform === 'darwin') return (await recognizeMac(tmp)).trim()
    if (process.platform === 'win32') return (await recognizeWindows(tmp)).trim()
    throw new Error('当前系统暂不支持截图文字识别')
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}
