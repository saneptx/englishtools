import { YoutubeTranscript } from 'youtube-transcript'
import { annotateSentences, type AnnotatedSentence } from './deepseek'
import { getSubtitleCache, setSubtitleCache } from './store'

export interface SubtitleCue {
  id: string
  startMs: number
  durationMs: number
  en: string
  zh: string
  keywords: { word: string; meaning: string }[]
}

export function extractVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed

  try {
    const url = new URL(trimmed)
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.slice(1).slice(0, 11) || null
    }
    const v = url.searchParams.get('v')
    if (v) return v
    const m = url.pathname.match(/\/(?:embed|shorts)\/([\w-]{11})/)
    if (m) return m[1]
  } catch {
    /* not url */
  }
  return null
}

export async function fetchAnnotatedSubtitles(videoIdOrUrl: string): Promise<SubtitleCue[]> {
  const videoId = extractVideoId(videoIdOrUrl)
  if (!videoId) throw new Error('无法解析 YouTube 视频 ID')

  const cached = getSubtitleCache(videoId) as SubtitleCue[] | null
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached
  }

  let raw: { text: string; offset: number; duration: number }[]
  try {
    raw = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' })
  } catch {
    try {
      raw = await YoutubeTranscript.fetchTranscript(videoId)
    } catch {
      throw new Error('该视频没有可用字幕，请换一个带英文字幕的视频')
    }
  }

  // youtube-transcript: srv3 uses ms; classic XML uses seconds
  const isMs = raw.some((r) => r.duration >= 50 || r.offset >= 10_000)
  const toMs = (n: number) => Math.round(isMs ? n : n * 1000)

  const paired = raw
    .map((r) => ({
      startMs: toMs(r.offset),
      durationMs: toMs(r.duration || (isMs ? 2000 : 2)),
      en: r.text.replace(/\n/g, ' ').trim(),
    }))
    .filter((r) => r.en)

  const sentences = paired.map((r) => r.en)
  let annotated: AnnotatedSentence[] = []
  try {
    annotated = await annotateSentences(sentences)
  } catch (err) {
    annotated = sentences.map((en) => ({ en, zh: '', keywords: [] }))
    console.error('annotate failed', err)
  }

  const cues: SubtitleCue[] = paired.map((r, i) => ({
    id: `${videoId}-${i}`,
    startMs: r.startMs,
    durationMs: r.durationMs || 2000,
    en: r.en,
    zh: annotated[i]?.zh ?? '',
    keywords: annotated[i]?.keywords ?? [],
  }))

  setSubtitleCache(videoId, cues)
  return cues
}
