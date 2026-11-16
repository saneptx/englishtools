/**
 * YouTube 字幕获取与切分。
 *
 * - 通过 InnerTube 的移动端客户端（ANDROID / IOS）拿字幕轨道：网页端接口现在需要 PO Token，移动端不需要。
 * - 自动字幕（asr）的 json3 格式带逐词时间（tOffsetMs），可以做逐词高亮。
 * - 人工字幕文本和标点更准确，但没有逐词时间：与自动字幕按词序对齐，借用其时间点；对不上的按字数插值。
 */

export interface CueWord {
  /** 显示文本（含标点） */
  t: string
  /** 开始时间（毫秒） */
  s: number
}

export interface SubtitleCue {
  id: string
  startMs: number
  endMs: number
  en: string
  words: CueWord[]
  zh?: string
  keywords?: { word: string; meaning: string }[]
}

export type TranscriptSource = 'manual' | 'asr' | 'whisper'

export interface VideoInfo {
  videoId: string
  title: string
  author: string
  lengthSec: number
}

export interface TimedWord {
  text: string
  startMs: number
  endMs: number
}

export function extractVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1, 12) || null
    const v = url.searchParams.get('v')
    if (v && /^[\w-]{11}$/.test(v)) return v
    const m = url.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/)
    if (m) return m[1]
  } catch {
    /* not a url */
  }
  return null
}

// ───────────────────────── InnerTube ─────────────────────────

type ClientProfile = {
  ua: string
  client: Record<string, string | number>
}

const CLIENTS: ClientProfile[] = [
  {
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 },
  },
  {
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    client: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,2' },
  },
]

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  kind?: string
  name?: { runs?: { text: string }[]; simpleText?: string }
}

interface PlayerData {
  info: VideoInfo
  tracks: CaptionTrack[]
  ua: string
}

async function fetchPlayer(videoId: string): Promise<PlayerData> {
  let lastError = ''
  for (const profile of CLIENTS) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': profile.ua },
        body: JSON.stringify({
          videoId,
          context: { client: { ...profile.client, hl: 'en', gl: 'US' } },
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      })
      if (!res.ok) {
        lastError = `HTTP ${res.status}`
        continue
      }
      const j = (await res.json()) as {
        playabilityStatus?: { status?: string; reason?: string }
        videoDetails?: { title?: string; author?: string; lengthSeconds?: string }
        captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } }
      }
      const status = j.playabilityStatus?.status
      if (status && status !== 'OK' && !j.videoDetails) {
        lastError = j.playabilityStatus?.reason || status
        continue
      }
      return {
        info: {
          videoId,
          title: j.videoDetails?.title || videoId,
          author: j.videoDetails?.author || '',
          lengthSec: Number(j.videoDetails?.lengthSeconds || 0),
        },
        tracks: j.captions?.playerCaptionsTracklistRenderer?.captionTracks || [],
        ua: profile.ua,
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(`无法获取视频信息：${lastError || '未知错误'}`)
}

interface Json3Event {
  tStartMs?: number
  dDurationMs?: number
  aAppend?: number
  segs?: { utf8?: string; tOffsetMs?: number }[]
}

async function fetchJson3(track: CaptionTrack, ua: string): Promise<Json3Event[]> {
  const url = track.baseUrl.replace(/&fmt=[^&]*/g, '') + '&fmt=json3'
  const res = await fetch(url, { headers: { 'User-Agent': ua } })
  if (!res.ok) throw new Error(`字幕下载失败 (HTTP ${res.status})`)
  const text = await res.text()
  if (!text.trim()) return []
  try {
    return ((JSON.parse(text) as { events?: Json3Event[] }).events || []).filter((e) => e.segs?.length)
  } catch {
    return []
  }
}

function pickTracks(tracks: CaptionTrack[]) {
  const en = tracks.filter((t) => /^en\b/i.test(t.languageCode))
  const manualOrder = (t: CaptionTrack) => (t.languageCode === 'en' ? 0 : t.languageCode === 'en-US' ? 1 : 2)
  const manual = en.filter((t) => t.kind !== 'asr').sort((a, b) => manualOrder(a) - manualOrder(b))[0]
  const asr = en.find((t) => t.kind === 'asr')
  return { manual, asr }
}

// ───────────────────────── 解析与切分 ─────────────────────────

const NON_SPEECH = /^\[[^\]]*\]$|^\([^)]*\)$/

function cleanText(s: string) {
  return s
    .replace(/\n/g, ' ')
    .replace(/^\s*>>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normWord(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 自动字幕 json3 → 逐词时间序列 */
export function parseAsrWords(events: Json3Event[]): TimedWord[] {
  const words: TimedWord[] = []
  for (const e of events) {
    if (e.aAppend) continue
    const base = e.tStartMs ?? 0
    const end = base + (e.dDurationMs ?? 0)
    for (const seg of e.segs || []) {
      const text = (seg.utf8 || '').trim()
      if (!text || NON_SPEECH.test(text)) continue
      words.push({ text, startMs: base + (seg.tOffsetMs ?? 0), endMs: end })
    }
  }
  words.sort((a, b) => a.startMs - b.startMs)
  // 每个词的结束时间取下一个词的开始时间（不超过所在事件结束）
  for (let i = 0; i < words.length - 1; i++) {
    words[i].endMs = Math.min(words[i].endMs, words[i + 1].startMs) || words[i + 1].startMs
    if (words[i].endMs <= words[i].startMs) words[i].endMs = words[i].startMs + 200
  }
  return words
}

/**
 * 按停顿 / 句末标点 / 长度把逐词序列切成字幕行。
 * 自动字幕没有标点，主要靠停顿；Whisper 结果带标点，优先在句末断开。
 */
export function cuesFromTimedWords(words: TimedWord[], idPrefix: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let cur: TimedWord[] = []
  const flush = () => {
    if (!cur.length) return
    cues.push({
      id: `${idPrefix}-${cues.length}`,
      startMs: cur[0].startMs,
      endMs: cur[cur.length - 1].endMs,
      en: cur.map((w) => w.text).join(' '),
      words: cur.map((w) => ({ t: w.text, s: w.startMs })),
    })
    cur = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (cur.length) {
      const prev = cur[cur.length - 1]
      const gap = w.startMs - prev.endMs
      const span = w.startMs - cur[0].startMs
      const sentenceEnd = /[.?!]["')\]]?$/.test(prev.text)
      if (
        gap > 700 ||
        cur.length >= 13 ||
        span > 6000 ||
        (sentenceEnd && cur.length >= 3) ||
        (cur.length >= 7 && gap > 250) ||
        (/[,;:]$/.test(prev.text) && cur.length >= 8)
      ) {
        flush()
      }
    }
    cur.push(w)
  }
  flush()
  return cues
}

interface ManualLine {
  text: string
  startMs: number
  endMs: number
}

/** 人工字幕行合并成句子（有上限，避免整段合成一行） */
function mergeManualLines(events: Json3Event[]): ManualLine[] {
  const lines: ManualLine[] = events
    .filter((e) => !e.aAppend)
    .map((e) => ({
      text: cleanText((e.segs || []).map((s) => s.utf8 || '').join('')),
      startMs: e.tStartMs ?? 0,
      endMs: (e.tStartMs ?? 0) + (e.dDurationMs ?? 0),
    }))
    .filter((l) => l.text && !NON_SPEECH.test(l.text))

  const merged: ManualLine[] = []
  let acc: ManualLine | null = null
  for (const l of lines) {
    if (!acc) {
      acc = { ...l }
    } else {
      acc.text += ' ' + l.text
      acc.endMs = Math.max(acc.endMs, l.endMs)
    }
    const words = acc.text.split(' ').length
    if (/[.?!]["')\]]?$/.test(acc.text) || words >= 22 || acc.endMs - acc.startMs > 10000) {
      merged.push(acc)
      acc = null
    }
  }
  if (acc) merged.push(acc)
  return merged
}

/** 给人工字幕的每个词分配时间：优先对齐自动字幕的同一个词，其余按字数在相邻已知时间点之间插值 */
function cuesFromManual(lines: ManualLine[], asr: TimedWord[], idPrefix: string): SubtitleCue[] {
  let j = 0
  return lines.map((line, idx) => {
    const tokens = line.text.split(' ').filter(Boolean)
    const times: (number | undefined)[] = tokens.map(() => undefined)
    // 自动字幕指针先跳到本行开始附近
    while (j < asr.length && asr[j].startMs < line.startMs - 1500) j++
    tokens.forEach((tok, i) => {
      const n = normWord(tok)
      if (!n) return
      for (let k = j; k < Math.min(asr.length, j + 10); k++) {
        if (asr[k].startMs > line.endMs + 1500) break
        if (normWord(asr[k].text) === n) {
          times[i] = asr[k].startMs
          j = k + 1
          break
        }
      }
    })
    // 插值：已知点之间按字符数分配
    const known = times
      .map((t, i) => (t === undefined ? -1 : i))
      .filter((i) => i >= 0)
    const anchors: { i: number; t: number }[] = [
      { i: -1, t: line.startMs },
      ...known.map((i) => ({ i, t: times[i]! })),
      { i: tokens.length, t: Math.max(line.endMs, (times[known[known.length - 1]] ?? line.startMs) + 300) },
    ]
    for (let a = 0; a < anchors.length - 1; a++) {
      const from = anchors[a]
      const to = anchors[a + 1]
      const gapIdx: number[] = []
      for (let i = from.i + 1; i < to.i; i++) gapIdx.push(i)
      if (!gapIdx.length) continue
      const weights = gapIdx.map((i) => tokens[i].length + 2)
      const total = weights.reduce((x, y) => x + y, 0) + (from.i >= 0 ? tokens[from.i].length + 2 : 0)
      let acc = from.i >= 0 ? tokens[from.i].length + 2 : 0
      gapIdx.forEach((i, k) => {
        times[i] = Math.round(from.t + ((to.t - from.t) * acc) / total)
        acc += weights[k]
      })
    }
    // 保证单调不减
    for (let i = 1; i < times.length; i++) times[i] = Math.max(times[i]!, times[i - 1]!)
    return {
      id: `${idPrefix}-${idx}`,
      startMs: Math.min(line.startMs, times[0] ?? line.startMs),
      endMs: Math.max(line.endMs, (times[times.length - 1] ?? line.startMs) + 300),
      en: line.text,
      words: tokens.map((t, i) => ({ t, s: times[i]! })),
    }
  })
}

export interface CaptionResult {
  info: VideoInfo
  source: TranscriptSource
  cues: SubtitleCue[]
}

/** 拿视频信息 + 英文字幕；没有英文字幕时 cues 为空（由调用方决定是否走语音识别） */
export async function fetchCaptions(videoId: string): Promise<CaptionResult> {
  const player = await fetchPlayer(videoId)
  const { manual, asr } = pickTracks(player.tracks)
  const asrWords = asr ? parseAsrWords(await fetchJson3(asr, player.ua).catch(() => [])) : []

  if (manual) {
    const events = await fetchJson3(manual, player.ua).catch(() => [])
    const lines = mergeManualLines(events)
    if (lines.length) {
      return { info: player.info, source: 'manual', cues: cuesFromManual(lines, asrWords, videoId) }
    }
  }
  if (asrWords.length) {
    return { info: player.info, source: 'asr', cues: cuesFromTimedWords(asrWords, videoId) }
  }
  return { info: player.info, source: 'asr', cues: [] }
}
