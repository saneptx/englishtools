import { translateSubtitleLines } from './deepseek'
import {
  getSubtitleCache,
  setSubtitleCache,
  pruneSubtitleCache,
  touchRecentVideo,
  getRecentVideos,
} from './store'
import {
  extractVideoId,
  fetchCaptions,
  cuesFromTimedWords,
  type SubtitleCue,
  type TranscriptSource,
  type VideoInfo,
} from './youtube'
import { transcribeVideo, type WhisperStage } from './whisper'

/**
 * YouTube 学习：加载字幕（缓存 → 自带字幕 → 语音识别），然后在后台分批翻译并推送给界面。
 */

const CACHE_VERSION = 'v2'
const BATCH = 18
const CONCURRENCY = 3

export interface LearnVideo {
  info: VideoInfo
  source: TranscriptSource
  cues: SubtitleCue[]
}

interface CacheEntry extends LearnVideo {
  translated: boolean
}

export type LearnStatus =
  | { videoId: string; stage: 'captions' }
  | { videoId: string; stage: WhisperStage; percent: number | null }
  | { videoId: string; stage: 'translating'; done: number; total: number }
  | { videoId: string; stage: 'done' }
  | { videoId: string; stage: 'error'; message: string }

export interface LearnEvents {
  status: (s: LearnStatus) => void
  translated: (videoId: string, items: { id: string; zh: string; keywords: SubtitleCue['keywords'] }[]) => void
}

const cacheKey = (videoId: string) => `${CACHE_VERSION}:${videoId}`

let currentJob: AbortController | null = null

export function cancelLearnJob() {
  currentJob?.abort()
  currentJob = null
}

export async function loadLearnVideo(input: string, ev: LearnEvents): Promise<LearnVideo> {
  const videoId = extractVideoId(input)
  if (!videoId) throw new Error('无法识别这个 YouTube 链接')

  cancelLearnJob()
  const job = new AbortController()
  currentJob = job

  const cached = getSubtitleCache(cacheKey(videoId)) as CacheEntry | null
  let video: LearnVideo
  if (cached?.cues?.length) {
    video = { info: cached.info, source: cached.source, cues: cached.cues }
  } else {
    ev.status({ videoId, stage: 'captions' })
    const cap = await fetchCaptions(videoId)
    let cues = cap.cues
    let source = cap.source
    if (!cues.length) {
      const words = await transcribeVideo(
        videoId,
        (stage, percent) => {
          if (!job.signal.aborted) ev.status({ videoId, stage, percent })
        },
        job.signal,
      )
      if (!words.length) throw new Error('没有识别到英文语音')
      cues = cuesFromTimedWords(words, videoId)
      source = 'whisper'
    }
    video = { info: cap.info, source, cues }
    saveCache(video, false)
  }

  touchRecentVideo({ videoId, title: video.info.title, author: video.info.author })
  pruneSubtitleCache(getRecentVideos().map((v) => cacheKey(v.videoId)))

  if (cached?.translated) {
    queueMicrotask(() => ev.status({ videoId, stage: 'done' }))
  } else {
    void translateInBackground(video, ev, job.signal)
  }
  return video
}

function saveCache(video: LearnVideo, translated: boolean) {
  const entry: CacheEntry = { ...video, translated }
  setSubtitleCache(cacheKey(video.info.videoId), entry)
}

async function translateInBackground(video: LearnVideo, ev: LearnEvents, signal: AbortSignal) {
  const { videoId, title } = video.info
  const pending = video.cues.map((c, i) => ({ c, i })).filter(({ c }) => !c.zh)
  const batches: { c: SubtitleCue; i: number }[][] = []
  for (let k = 0; k < pending.length; k += BATCH) batches.push(pending.slice(k, k + BATCH))
  let done = video.cues.length - pending.length
  const total = video.cues.length
  let failed = 0
  ev.status({ videoId, stage: 'translating', done, total })

  let next = 0
  const worker = async () => {
    while (next < batches.length && !signal.aborted) {
      const batch = batches[next++]
      const firstIdx = batch[0].i
      const before = video.cues.slice(Math.max(0, firstIdx - 3), firstIdx).map((c) => c.en)
      let result: Awaited<ReturnType<typeof translateSubtitleLines>> | null = null
      for (let attempt = 0; attempt < 2 && !result && !signal.aborted; attempt++) {
        try {
          result = await translateSubtitleLines(
            batch.map(({ c }) => c.en),
            { title, before },
          )
        } catch (err) {
          if (attempt === 1) {
            failed++
            const message = err instanceof Error ? err.message : String(err)
            ev.status({ videoId, stage: 'error', message })
          }
        }
      }
      if (signal.aborted || !result) continue
      const items = batch.map(({ c }, k) => {
        c.zh = result![k].zh
        c.keywords = result![k].keywords
        return { id: c.id, zh: c.zh, keywords: c.keywords }
      })
      done += batch.length
      ev.translated(videoId, items)
      ev.status({ videoId, stage: 'translating', done, total })
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
  if (signal.aborted) return
  saveCache(video, failed === 0)
  if (failed === 0) ev.status({ videoId, stage: 'done' })
}
