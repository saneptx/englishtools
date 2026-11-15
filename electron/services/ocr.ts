import TesseractImport from 'tesseract.js'
import { nativeImage } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const Tesseract = ((TesseractImport as unknown as { default?: typeof TesseractImport }).default ??
  TesseractImport) as typeof TesseractImport

export async function ocrImageBuffer(pngBuffer: Buffer): Promise<string> {
  const tmp = join(tmpdir(), `englishtools-ocr-${Date.now()}.png`)
  try {
    await writeFile(tmp, pngBuffer)
    const result = await Tesseract.recognize(tmp, 'eng', {
      logger: () => undefined,
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
