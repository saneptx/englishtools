import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, createWriteStream } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir, cpus } from 'node:os'
import type { TimedWord } from './youtube'

/**
 * 没有英文字幕的视频：yt-dlp 下载音轨 → ffmpeg 转 16kHz 单声道 → whisper.cpp 逐词识别。
 * 三个工具需用户自行安装（见 missingToolsHint），模型首次使用时自动下载到用户数据目录。
 */

const IS_WIN = process.platform === 'win32'
const MODEL_NAME = 'ggml-base.en.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`

export type WhisperStage = 'model' | 'download' | 'convert' | 'transcribe'
export type WhisperProgress = (stage: WhisperStage, percent: number | null) => void

/** 从 Finder / 开始菜单启动时 PATH 很短，额外查找常见安装位置 */
function searchDirs(): string[] {
  const fromEnv = (process.env.PATH || '').split(delimiter)
  const extra = IS_WIN
    ? [
        join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
        join(app.getPath('userData'), 'bin'),
      ]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(app.getPath('home'), '.local', 'bin')]
  return [...new Set([...fromEnv, ...extra].filter(Boolean))]
}

function findExecutable(names: string[]): string | null {
  const dirs = searchDirs()
  for (const name of names) {
    for (const dir of dirs) {
      const p = join(dir, IS_WIN ? `${name}.exe` : name)
      if (existsSync(p)) return p
    }
  }
  return null
}

export function detectTools() {
  return {
    ytdlp: findExecutable(['yt-dlp']),
    ffmpeg: findExecutable(['ffmpeg']),
    // whisper.cpp 新版叫 whisper-cli，Homebrew 旧版叫 whisper-cpp
    whisper: findExecutable(['whisper-cli', 'whisper-cpp']),
  }
}

function missingToolsHint(missing: string[]) {
  const install = IS_WIN
    ? 'winget install yt-dlp.yt-dlp Gyan.FFmpeg，whisper.cpp 从 GitHub Releases 下载 whisper-bin-x64.zip 并把 whisper-cli.exe 所在目录加入 PATH'
    : 'brew install yt-dlp ffmpeg whisper-cpp'
  return `该视频没有英文字幕，语音识别需要 ${missing.join('、')}。安装方法：${install}`
}

function run(
  cmd: string,
  args: string[],
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    const tail: string[] = []
    const feed = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n|\r/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 8) tail.shift()
        onLine?.(line)
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (err) => {
      signal?.removeEventListener('abort', abort)
      reject(err)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('已取消'))
      else if (code === 0) resolve()
      else reject(new Error(`${cmd.split(/[\\/]/).pop()} 退出码 ${code}：${tail.slice(-3).join(' ')}`))
    })
  })
}

async function ensureModel(onProgress: WhisperProgress, signal?: AbortSignal): Promise<string> {
  const dir = join(app.getPath('userData'), 'models')
  const file = join(dir, MODEL_NAME)
  if (existsSync(file)) return file
  mkdirSync(dir, { recursive: true })
  onProgress('model', 0)
  const res = await fetch(MODEL_URL, { signal })
  if (!res.ok || !res.body) throw new Error(`语音识别模型下载失败 (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length') || 0)
  const part = `${file}.part`
  const out = createWriteStream(part)
  let received = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      if (total) onProgress('model', Math.round((received / total) * 100))
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
  renameSync(part, file)
  return file
}

/** 识别整段视频语音，返回逐词时间序列 */
export async function transcribeVideo(
  videoId: string,
  onProgress: WhisperProgress,
  signal?: AbortSignal,
): Promise<TimedWord[]> {
  const tools = detectTools()
  const missing = Object.entries({ 'yt-dlp': tools.ytdlp, ffmpeg: tools.ffmpeg, 'whisper.cpp': tools.whisper })
    .filter(([, p]) => !p)
    .map(([n]) => n)
  if (missing.length) throw new Error(missingToolsHint(missing))

  const model = await ensureModel(onProgress, signal)
  const work = mkdtempSync(join(tmpdir(), 'englishtools-whisper-'))
  try {
    onProgress('download', 0)
    await run(
      tools.ytdlp!,
      [
        '-f',
        'bestaudio[ext=m4a]/bestaudio',
        '--no-playlist',
        '--newline',
        '-o',
        join(work, 'audio.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      (line) => {
        const m = line.match(/\[download\]\s+([\d.]+)%/)
        if (m) onProgress('download', Math.round(Number(m[1])))
      },
      signal,
    )
    const audio = readdirSync(work).find((f) => f.startsWith('audio.'))
    if (!audio) throw new Error('音频下载失败')

    onProgress('convert', null)
    const wav = join(work, 'audio.wav')
    await run(
      tools.ffmpeg!,
      ['-y', '-loglevel', 'error', '-i', join(work, audio), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
      undefined,
      signal,
    )

    onProgress('transcribe', 0)
    const outBase = join(work, 'out')
    await run(
      tools.whisper!,
      [
        '-m', model,
        '-f', wav,
        '-l', 'en',
        '-t', String(Math.max(2, Math.min(8, cpus().length - 1))),
        // 每段一个词 + 按词切分 → 逐词时间
        '-ml', '1',
        '-sow',
        '-oj',
        '-of', outBase,
        '-pp',
      ],
      (line) => {
        const m = line.match(/progress\s*=\s*(\d+)%/)
        if (m) onProgress('transcribe', Number(m[1]))
      },
      signal,
    )

    const json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as {
      transcription?: { offsets?: { from: number; to: number }; text?: string }[]
    }
    const words: TimedWord[] = []
    for (const seg of json.transcription || []) {
      const text = (seg.text || '').trim()
      if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue
      const from = seg.offsets?.from ?? 0
      const to = seg.offsets?.to ?? from + 300
      // 标点有时单独成段，并到前一个词上
      if (/^[^\w]+$/.test(text) && words.length) {
        words[words.length - 1].text += text
        continue
      }
      words.push({ text, startMs: from, endMs: Math.max(to, from + 100) })
    }
    return words
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
