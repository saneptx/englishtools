import TesseractImport from 'tesseract.js'
import { app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const Tesseract = ((TesseractImport as unknown as { default?: typeof TesseractImport }).default ??
  TesseractImport) as typeof TesseractImport

/**
 * 英文识别数据 eng.traineddata 所在目录：
 * 开发时在项目根目录；打包后由 electron-builder 复制到 resources/tessdata。
 */
function langDir(): string {
  const candidates = [join(process.resourcesPath || '', 'tessdata'), app.getAppPath(), process.cwd()]
  return candidates.find((d) => existsSync(join(d, 'eng.traineddata'))) ?? app.getAppPath()
}

export async function ocrImageBuffer(pngBuffer: Buffer): Promise<string> {
  const tmp = join(tmpdir(), `englishtools-ocr-${Date.now()}.png`)
  try {
    await writeFile(tmp, pngBuffer)
    const result = await Tesseract.recognize(tmp, 'eng', {
      logger: () => undefined,
      // tesseract 在 Node 下只会从「缓存目录」读本地语言数据（langPath 会被当成网址下载），
      // 所以把缓存目录指向自带的数据并设为只读：不联网、不往（打包后只读的）工作目录写文件
      cachePath: langDir(),
      cacheMethod: 'readOnly',
      gzip: false,
    })
    return (result.data.text || '').trim()
  } finally {
    try {
      await unlink(tmp)
    } catch {
      /* ignore */
    }
  }
}

export async function ocrFromDataUrl(dataUrl: string): Promise<string> {
  const img = nativeImage.createFromDataURL(dataUrl)
  const png = img.toPNG()
  return ocrImageBuffer(png)
}
