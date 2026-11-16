import { nativeImage, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findInputCard, type PixelRect } from './inputCardDetect'

/**
 * macOS：对「读不到无障碍信息」的聊天应用（微信 4.x 等 Qt 自绘界面），
 * 截取窗口底部 → 定位输入框卡片 → 用系统 Vision 框架识别其中文字。
 * 全程不发送任何按键、不碰剪贴板；需要「屏幕录制」权限。
 */

const execFileAsync = promisify(execFile)

type Rect = { x: number; y: number; width: number; height: number }

/** 输入框卡片底部的工具栏（表情 / 文件 / 发送按钮）高度，单位：点 */
const TOOLBAR_PT = 44
/** 截取窗口底部的比例：输入框一般不会超过窗口一半高 */
const CAPTURE_RATIO = 0.55

const VISION_JXA = `
ObjC.import('Foundation')
ObjC.import('Vision')
function run(argv) {
  const req = $.VNRecognizeTextRequest.alloc.init
  req.recognitionLevel = 0
  req.recognitionLanguages = $(['zh-Hans', 'zh-Hant', 'en-US'])
  req.usesLanguageCorrection = true
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}))
  if (!handler.performRequestsError($([req]), null)) return '[]'
  const out = []
  const results = req.results
  for (let i = 0; i < results.count; i++) {
    const obs = results.objectAtIndex(i)
    const top = obs.topCandidates(1)
    if (!top.count) continue
    const b = obs.boundingBox
    out.push({ t: top.objectAtIndex(0).string.js, x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height })
  }
  return JSON.stringify(out)
}
`

let workDir: string | null = null
function dir() {
  if (!workDir) {
    workDir = mkdtempSync(join(tmpdir(), 'englishtools-ocr-'))
    writeFileSync(join(workDir, 'vision.js'), VISION_JXA)
    process.once('exit', () => {
      try {
        rmSync(workDir!, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    })
  }
  return workDir
}

export type Observation = { t: string; x: number; y: number; w: number; h: number }

export async function visionOcr(pngPath: string): Promise<Observation[]> {
  const { stdout } = await execFileAsync(
    'osascript',
    ['-l', 'JavaScript', join(dir(), 'vision.js'), pngPath],
    { timeout: 20000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  )
  try {
    const parsed = JSON.parse(stdout.trim() || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function macScreenOcrAvailable() {
  return process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'granted'
}

/**
 * Vision 首次识别中文要加载 / 编译模型（实测 10 秒以上），启动时先在后台空跑一次。
 */
export async function warmUpMacOcr(): Promise<void> {
  if (process.platform !== 'darwin') return
  const file = join(dir(), 'warmup.png')
  const w = 64
  const h = 24
  const bmp = Buffer.alloc(w * h * 4, 255)
  writeFileSync(file, nativeImage.createFromBitmap(bmp, { width: w, height: h }).toPNG())
  await visionOcr(file).catch(() => undefined)
}

export interface OcrInputResult {
  text: string
  /** 最后一行文字的屏幕矩形（点），卡片显示在它正下方 */
  anchor: Rect
}

export async function macReadInputByOcr(windowRect: Rect, debug = false): Promise<OcrInputResult | null> {
  if (!macScreenOcrAvailable()) {
    if (debug) console.log('[ocr] 未授予屏幕录制权限，跳过')
    return null
  }
  const t0 = Date.now()
  const region = {
    x: Math.round(windowRect.x),
    y: Math.round(windowRect.y + windowRect.height * (1 - CAPTURE_RATIO)),
    width: Math.round(windowRect.width),
    height: Math.round(windowRect.height * CAPTURE_RATIO),
  }
  const shot = join(dir(), 'shot.png')
  const crop = join(dir(), 'card.png')
  try {
    await execFileAsync(
      'screencapture',
      ['-x', '-t', 'png', '-R', `${region.x},${region.y},${region.width},${region.height}`, shot],
      { timeout: 4000 },
    )
  } catch (err) {
    if (debug) console.log('[ocr] screencapture failed', err)
    return null
  }

  const img = nativeImage.createFromPath(shot)
  if (img.isEmpty()) return null
  return recognizeInputCard(img, region, crop, debug, t0)
}

/** 在已截取的窗口底部图像里定位输入框并识别文字（单独导出便于用样图测试） */
export async function recognizeInputCard(
  img: Electron.NativeImage,
  region: Rect,
  cropPath: string,
  debug = false,
  t0 = Date.now(),
): Promise<OcrInputResult | null> {
  const size = img.getSize()
  const scale = size.width / region.width
  const card = findInputCard(img.toBitmap(), size.width, size.height, { scale })
  if (!card) {
    if (debug) console.log(`[ocr] 没找到输入框 ${Date.now() - t0}ms`)
    return null
  }
  writeFileSync(cropPath, img.crop(card).toPNG())
  const t1 = Date.now()
  const obs = await visionOcr(cropPath)

  // Vision 坐标：相对裁剪图归一化，原点在左下角
  const toolbarPx = TOOLBAR_PT * scale
  const lines = obs
    .map((o) => ({
      text: o.t.trim(),
      left: card.x + o.x * card.width,
      top: card.y + (1 - o.y - o.h) * card.height,
      width: o.w * card.width,
      height: o.h * card.height,
    }))
    .filter((l) => l.text && !/^(send|发送|發送)$/i.test(l.text))
    // 去掉底部工具栏里被误识别的图标
    .filter((l) => l.top + l.height / 2 < card.y + card.height - toolbarPx)
    .sort((a, b) => a.top - b.top || a.left - b.left)

  if (debug) {
    console.log(
      `[ocr] card=${JSON.stringify(card)} scale=${scale} lines=${lines.length} ` +
        `capture+detect=${t1 - t0}ms vision=${Date.now() - t1}ms`,
    )
  }
  if (!lines.length) return { text: '', anchor: toScreen(region, scale, card, card) }

  // 同一视觉行的多个片段按左右顺序拼接，不同行用换行连接
  const rows: (typeof lines)[] = []
  for (const l of lines) {
    const row = rows.find((r) => Math.abs(r[0].top - l.top) < l.height * 0.5)
    if (row) row.push(l)
    else rows.push([l])
  }
  const text = rows
    .map((r) =>
      r
        .sort((a, b) => a.left - b.left)
        .map((l) => l.text)
        .join(' '),
    )
    .join('\n')
  const last = lines[lines.length - 1]
  const lastPx: PixelRect = {
    x: Math.min(...lines.map((l) => l.left)),
    y: last.top,
    width: Math.max(...lines.map((l) => l.left + l.width)) - Math.min(...lines.map((l) => l.left)),
    height: last.height,
  }
  return { text, anchor: toScreen(region, scale, lastPx, card) }
}

/** 位图像素矩形 → 屏幕点坐标 */
function toScreen(region: Rect, scale: number, r: PixelRect, card: PixelRect): Rect {
  return {
    x: region.x + Math.max(r.x, card.x) / scale,
    y: region.y + r.y / scale,
    width: Math.max(20, r.width / scale),
    height: Math.max(16, r.height / scale),
  }
}
