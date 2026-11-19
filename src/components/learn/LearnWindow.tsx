import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TitleBar from '../TitleBar'
import { CueCard, formatTime, norm, type WordClick } from './CueCard'
import { useYouTubePlayer } from './useYouTubePlayer'
import { useSpeech } from './useSpeech'
import type { LearnStatus, LearnVideo, RecentVideo, SubtitleCue, VocabItem } from '../../../electron/preload'

const api = window.englishTools

function parseVideoId(input: string): string | null {
  const t = input.trim()
  if (/^[\w-]{11}$/.test(t)) return t
  try {
    const u = new URL(t)
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1, 12) || null
    const v = u.searchParams.get('v')
    if (v && /^[\w-]{11}$/.test(v)) return v
    return u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1] ?? null
  } catch {
    return null
  }
}

/** 最后一个 startMs <= t 的下标 */
function findIndex<T>(arr: T[], t: number, key: (x: T) => number) {
  let lo = 0
  let hi = arr.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (key(arr[mid]) <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

function cleanError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const SOURCE_LABEL: Record<LearnVideo['source'], string> = {
  manual: '人工字幕',
  asr: '自动字幕',
  whisper: '语音识别',
}

function statusText(s: LearnStatus | null): string | null {
  if (!s) return null
  const pct = 'percent' in s && s.percent != null ? ` ${s.percent}%` : ''
  switch (s.stage) {
    case 'captions':
      return '正在获取字幕…'
    case 'model':
      return `首次使用，正在下载语音识别模型${pct}`
    case 'download':
      return `没有英文字幕，正在下载音频${pct}`
    case 'convert':
      return '正在转换音频…'
    case 'transcribe':
      return `正在识别语音${pct}`
    case 'translating':
      return `翻译中 ${s.done}/${s.total}`
    default:
      return null
  }
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** 按档位加速 / 减速；当前速度不在档位里时取最接近的一档 */
function stepRate(cur: number, dir: 1 | -1) {
  let at = 0
  RATES.forEach((r, i) => {
    if (Math.abs(r - cur) < Math.abs(RATES[at] - cur)) at = i
  })
  return RATES[Math.min(RATES.length - 1, Math.max(0, at + dir))]
}

function popoverWord(p: WordClick) {
  return p.keyword?.word ?? p.cue.words[p.index].t.replace(/^[^\w']+|[^\w']+$/g, '')
}

/** 查词结果里第一行带中文的内容（跳过单词本身、音标等），作为生词本里的简短释义 */
function firstLine(text: string | null | undefined) {
  const lines = (text || '')
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').replace(/^[\s\-*•\d.、]+/, '').trim())
    .filter(Boolean)
  return (lines.find((l) => /[\u4e00-\u9fff]/.test(l)) || '').slice(0, 80)
}

type Tab = 'recent' | 'vocab'

export default function LearnWindow() {
  const [input, setInput] = useState('')
  const [videoId, setVideoId] = useState<string | null>(null)
  const [video, setVideo] = useState<LearnVideo | null>(null)
  const [cues, setCues] = useState<SubtitleCue[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<LearnStatus | null>(null)
  const [translateError, setTranslateError] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentVideo[]>([])
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [showZh, setShowZh] = useState(true)
  const [follow, setFollow] = useState(true)
  const [tab, setTab] = useState<Tab>('recent')
  const [vocab, setVocab] = useState<VocabItem[]>([])
  const [popover, setPopover] = useState<(WordClick & { text: string | null; error?: boolean }) | null>(null)

  const player = useYouTubePlayer(videoId)
  const pendingSeek = useRef<number | null>(null)
  const savedWords = useMemo(() => new Set(vocab.map((v) => norm(v.word))), [vocab])
  const savedWordsRef = useRef(savedWords)
  savedWordsRef.current = savedWords
  const listRef = useRef<HTMLDivElement>(null)
  const userScrollAt = useRef(0)
  const videoIdRef = useRef<string | null>(null)
  videoIdRef.current = videoId

  useEffect(() => {
    void api.learnRecent().then(setRecent)
    void api.vocabList().then(setVocab)
    void api.learnPrefs().then((p) => player.setRate(p.rate))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const changeRate = useCallback(
    (r: number) => {
      player.setRate(r)
      void api.setLearnPrefs({ rate: r })
    },
    [player.setRate],
  )

  // 从生词本跳回原句：播放器就绪后定位
  useEffect(() => {
    if (!player.ready || pendingSeek.current == null) return
    const ms = pendingSeek.current
    pendingSeek.current = null
    player.seekTo(ms)
  }, [player.ready, player.seekTo])


  // 后台进度与翻译结果
  useEffect(() => {
    const offStatus = api.onLearnStatus((s) => {
      if (s.videoId !== videoIdRef.current) return
      if (s.stage === 'error') setTranslateError(s.message)
      else setStatus(s.stage === 'done' ? null : s)
    })
    const offTranslated = api.onLearnTranslated(({ videoId: id, items }) => {
      if (id !== videoIdRef.current) return
      const byId = new Map(items.map((i) => [i.id, i]))
      setCues((prev) =>
        prev.map((c) => {
          const t = byId.get(c.id)
          return t ? { ...c, zh: t.zh, keywords: t.keywords } : c
        }),
      )
    })
    return () => {
      offStatus()
      offTranslated()
    }
  }, [])

  const open = useCallback(async (raw: string, startMs?: number) => {
    const id = parseVideoId(raw)
    if (!id) {
      setLoadError('无法识别这个 YouTube 链接')
      return
    }
    setInput('')
    pendingSeek.current = startMs ?? null
    setVideoId(id)
    setVideo(null)
    setCues([])
    setLoadError(null)
    setTranslateError(null)
    setStatus(null)
    setPopover(null)
    setLoading(true)
    try {
      const v = await api.learnLoad(id)
      if (videoIdRef.current !== id) return
      setVideo(v)
      setCues(v.cues)
      const favs = await api.learnFavorites()
      setFavorites(new Set(favs.filter((f) => f.videoId === id).map((f) => f.key)))
      void api.learnRecent().then(setRecent)
    } catch (err) {
      if (videoIdRef.current === id) setLoadError(cleanError(err))
    } finally {
      if (videoIdRef.current === id) setLoading(false)
    }
  }, [])

  // 启动参数 #/learn?v=... 或主进程推送的视频
  useEffect(() => {
    const v = new URLSearchParams(location.hash.split('?')[1] || '').get('v')
    if (v) void open(v)
    return api.onLearnOpenVideo((input) => void open(input))
  }, [open])

  const goHome = (toTab?: Tab) => {
    if (toTab) setTab(toTab)
    player.pause()
    setVideoId(null)
    setVideo(null)
    setCues([])
    setLoadError(null)
    setStatus(null)
    setPopover(null)
  }

  // 当前句 / 当前词
  const t = player.timeMs
  const activeIdx = useMemo(() => {
    const i = findIndex(cues, t, (c) => c.startMs)
    if (i < 0) return -1
    // 句子结束后、下一句开始前的空档仍保持高亮上一句（最多 1.5 秒）
    return t <= cues[i].endMs + 1500 ? i : -1
  }, [cues, t])
  const activeCue = activeIdx >= 0 ? cues[activeIdx] : null
  const wordIdx = activeCue ? findIndex(activeCue.words, t, (w) => w.s) : -1

  // 当前句自动滚动到视野中部（用户手动滚动后暂停 4 秒）
  useEffect(() => {
    if (!follow || !activeCue || Date.now() - userScrollAt.current < 4000) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cue-id="${activeCue.id}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeCue, follow])

  const onSeek = useCallback(
    (cue: SubtitleCue) => {
      setPopover(null)
      player.seekTo(cue.startMs)
    },
    [player.seekTo],
  )

  const onWord = useCallback(
    (w: WordClick) => {
      player.pause()
      const word = popoverWord(w)
      setPopover({ ...w, text: null })
      api
        .learnLookup(word, w.cue.en)
        .then((text) => {
          setPopover((p) => (p && p.cue.id === w.cue.id && p.index === w.index ? { ...p, text } : p))
          // 查词结果返回前就点了收藏：补上释义
          if (savedWordsRef.current.has(norm(word))) {
            void api.vocabUpdate(word, { meaning: w.keyword?.meaning || firstLine(text), detail: text }).then(setVocab)
          }
        })
        .catch((err) =>
          setPopover((p) =>
            p && p.cue.id === w.cue.id && p.index === w.index ? { ...p, text: cleanError(err), error: true } : p,
          ),
        )
    },
    [player.pause],
  )

  const onFavorite = useCallback(
    async (cue: SubtitleCue) => {
      if (!video) return
      const key = `${video.info.videoId}:${cue.id}`
      const on = await api.learnToggleFavorite({
        key,
        videoId: video.info.videoId,
        title: video.info.title,
        startMs: cue.startMs,
        en: cue.en,
        zh: cue.zh || '',
      })
      setFavorites((prev) => {
        const next = new Set(prev)
        if (on) next.add(key)
        else next.delete(key)
        return next
      })
    },
    [video],
  )

  // 键盘：空格播放 / 暂停，←/→ 上一句 / 下一句，R 重播本句，Esc 关闭释义
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !videoId) return
      if (e.key === 'Escape') setPopover(null)
      if (!cues.length && e.key !== ' ') return
      if (e.key === ' ') {
        e.preventDefault()
        player.togglePlay()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const i = activeIdx > 0 ? activeIdx - 1 : 0
        player.seekTo(cues[i].startMs)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const i = Math.min(cues.length - 1, activeIdx + 1)
        player.seekTo(cues[i].startMs)
      } else if (e.key.toLowerCase() === 'r' && activeCue) {
        player.seekTo(activeCue.startMs)
      } else if (e.key === '-' || e.key === '_') {
        changeRate(stepRate(player.rate, -1))
      } else if (e.key === '=' || e.key === '+') {
        changeRate(stepRate(player.rate, 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [videoId, cues, activeIdx, activeCue, player.togglePlay, player.seekTo, player.rate, changeRate])

  const toggleWord = useCallback(
    async (p: WordClick & { text: string | null; error?: boolean }) => {
      const word = popoverWord(p)
      // 查词失败时 text 是报错信息，不能当释义存
      const text = p.error ? null : p.text
      const next = await api.vocabToggle({
        word,
        meaning: p.keyword?.meaning || firstLine(text),
        detail: text || undefined,
        context: p.cue.en,
        contextZh: p.cue.zh || undefined,
        videoId: videoIdRef.current || undefined,
        title: video?.info.title,
        startMs: p.cue.startMs,
      })
      setVocab(next)
    },
    [video],
  )

  const progressText = statusText(status)
  const translating = status?.stage === 'translating'

  return (
    <div className="app-shell learn">
      <TitleBar title={video?.info.title || 'YouTube 学习'} />

      <form
        className="learn-toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          if (input.trim()) void open(input)
        }}
      >
        {videoId && (
          <button type="button" className="icon-btn" title="返回" aria-label="返回" onClick={() => goHome()}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
        )}
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="粘贴 YouTube 视频链接，回车打开"
          spellCheck={false}
        />
        <button type="submit" className="btn" disabled={!input.trim()}>
          打开
        </button>
        <button
          type="button"
          className={`btn secondary vocab-btn${!videoId && tab === 'vocab' ? ' is-on' : ''}`}
          onClick={() => (videoId ? goHome('vocab') : setTab((t) => (t === 'vocab' ? 'recent' : 'vocab')))}
          title="生词本"
        >
          生词本{vocab.length > 0 && <span className="vocab-count">{vocab.length}</span>}
        </button>
      </form>

      {!videoId ? (
        <Landing
          tab={tab}
          onTab={setTab}
          recent={recent}
          vocab={vocab}
          onOpen={(id, startMs) => void open(id, startMs)}
          onRemove={(id) => void api.learnRemoveRecent(id).then(setRecent)}
          onRemoveWord={(id) => void api.vocabRemove(id).then(setVocab)}
          error={loadError}
        />
      ) : (
        <div className="learn-body">
          <section className="player-col">
            <div className="player-frame">
              <div ref={player.hostRef} className="player-host" />
              {player.error && (
                <div className="player-error">
                  <p>{player.error}</p>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => void api.openExternal(`https://www.youtube.com/watch?v=${videoId}`)}
                  >
                    在浏览器中打开
                  </button>
                </div>
              )}
            </div>
            {video && (
              <div className="video-meta">
                <div className="video-title">{video.info.title}</div>
                <div className="video-sub">
                  {video.info.author}
                  <span className="dot">·</span>
                  {SOURCE_LABEL[video.source]}
                  <span className="dot">·</span>
                  {cues.length} 句
                </div>
              </div>
            )}
            <p className="learn-tips">
              <kbd>空格</kbd> 播放 / 暂停 <kbd>←</kbd>
              <kbd>→</kbd> 上一句 / 下一句 <kbd>R</kbd> 重播本句 <kbd>-</kbd>
              <kbd>=</kbd> 减速 / 加速 · 点击单词查看释义、收藏生词
            </p>
          </section>

          <section className="subs-col">
            <header className="subs-head">
              <div className="subs-title">
                字幕
                {progressText && <span className="subs-status">{progressText}</span>}
              </div>
              <div className="subs-tools">
                <button
                  type="button"
                  className={`chip${showZh ? ' is-on' : ''}`}
                  onClick={() => setShowZh((v) => !v)}
                >
                  中文
                </button>
                <button
                  type="button"
                  className={`chip${follow ? ' is-on' : ''}`}
                  onClick={() => {
                    setFollow((v) => !v)
                    userScrollAt.current = 0
                  }}
                >
                  跟随
                </button>
                <div className="rate-ctl" role="group" aria-label="播放速度">
                  <button
                    type="button"
                    title="减速（-）"
                    aria-label="减速"
                    disabled={player.rate <= RATES[0]}
                    onClick={() => changeRate(stepRate(player.rate, -1))}
                  >
                    −
                  </button>
                  <select
                    value={RATES.includes(player.rate) ? player.rate : 1}
                    onChange={(e) => changeRate(Number(e.target.value))}
                    aria-label="播放速度"
                    className={player.rate !== 1 ? 'is-changed' : ''}
                  >
                    {RATES.map((r) => (
                      <option key={r} value={r}>
                        {r}×
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    title="加速（=）"
                    aria-label="加速"
                    disabled={player.rate >= RATES[RATES.length - 1]}
                    onClick={() => changeRate(stepRate(player.rate, 1))}
                  >
                    +
                  </button>
                </div>
              </div>
            </header>
            {translating && status.stage === 'translating' && (
              <div className="subs-progress">
                <span style={{ width: `${(status.done / Math.max(1, status.total)) * 100}%` }} />
              </div>
            )}
            {translateError && <div className="subs-warning">部分翻译失败：{translateError}</div>}

            <div
              className="cue-list"
              ref={listRef}
              // 只有用户自己滚动才暂停跟随、收起释义；程序自动滚动不算
              onWheel={() => {
                userScrollAt.current = Date.now()
                if (popover) setPopover(null)
              }}
              onTouchMove={() => {
                userScrollAt.current = Date.now()
                if (popover) setPopover(null)
              }}
            >
              {loading && !cues.length && (
                <div className="subs-empty">
                  <span className="inline-spinner" />
                  {progressText || '正在加载…'}
                </div>
              )}
              {loadError && (
                <div className="subs-empty is-error">
                  <p>{loadError}</p>
                  <button type="button" className="btn btn-small" onClick={() => void open(videoId)}>
                    重试
                  </button>
                </div>
              )}
              {cues.map((cue, i) => (
                <CueCard
                  key={cue.id}
                  cue={cue}
                  active={i === activeIdx}
                  wordIndex={i === activeIdx ? wordIdx : -1}
                  showZh={showZh}
                  favorite={favorites.has(`${videoId}:${cue.id}`)}
                  savedWords={savedWords}
                  onSeek={onSeek}
                  onWord={onWord}
                  onFavorite={onFavorite}
                />
              ))}
            </div>
          </section>
        </div>
      )}

      {popover && (
        <WordPopover
          popover={popover}
          saved={savedWords.has(norm(popoverWord(popover)))}
          onToggleSave={() => void toggleWord(popover)}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}

function Landing({
  tab,
  onTab,
  recent,
  vocab,
  onOpen,
  onRemove,
  onRemoveWord,
  error,
}: {
  tab: Tab
  onTab: (t: Tab) => void
  recent: RecentVideo[]
  vocab: VocabItem[]
  onOpen: (id: string, startMs?: number) => void
  onRemove: (id: string) => void
  onRemoveWord: (id: string) => void
  error: string | null
}) {
  return (
    <div className="learn-landing">
      {tab === 'recent' && (
        <div className="landing-hero">
          <h1>边看视频边学英语</h1>
          <p>粘贴 YouTube 链接，自动生成逐词同步的双语字幕，并标出值得学的词。</p>
          {error && <p className="landing-error">{error}</p>}
        </div>
      )}
      <div className="landing-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'recent'} className={tab === 'recent' ? 'is-on' : ''} onClick={() => onTab('recent')}>
          最近观看
        </button>
        <button type="button" role="tab" aria-selected={tab === 'vocab'} className={tab === 'vocab' ? 'is-on' : ''} onClick={() => onTab('vocab')}>
          生词本{vocab.length > 0 && <span className="tab-count">{vocab.length}</span>}
        </button>
      </div>
      {tab === 'recent' ? (
        recent.length > 0 ? (
          <div className="recent-grid">
            {recent.map((v) => (
              <div key={v.videoId} className="recent-card" onClick={() => onOpen(v.videoId)}>
                <div className="recent-thumb">
                  <img src={`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
                  <button
                    type="button"
                    className="recent-remove"
                    aria-label="从列表移除"
                    title="从列表移除"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(v.videoId)
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className="recent-title">{v.title}</div>
                <div className="recent-sub">{v.author}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="landing-empty">还没有看过的视频</p>
        )
      ) : (
        <VocabList items={vocab} onOpen={onOpen} onRemove={onRemoveWord} />
      )}
    </div>
  )
}

/** 原句里把生词加粗 */
function highlight(sentence: string, word: string) {
  const target = norm(word)
  return sentence.split(/(\s+)/).map((tok, i) =>
    target && norm(tok) === target ? <mark key={i}>{tok}</mark> : tok,
  )
}

function VocabList({
  items,
  onOpen,
  onRemove,
}: {
  items: VocabItem[]
  onOpen: (id: string, startMs?: number) => void
  onRemove: (id: string) => void
}) {
  const { speak, stop, speaking } = useSpeech()
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  useEffect(() => {
    if (!speaking) setSpeakingId(null)
  }, [speaking])

  if (!items.length) {
    return (
      <p className="landing-empty">
        还没有生词。看视频时点击字幕里的单词，在释义卡片上点「收藏」即可加入生词本。
      </p>
    )
  }
  const q = query.trim().toLowerCase()
  const shown = q
    ? items.filter((v) => v.word.toLowerCase().includes(q) || v.meaning.toLowerCase().includes(q))
    : items

  return (
    <div className="vocab">
      <input
        className="input vocab-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`在 ${items.length} 个生词中搜索`}
        spellCheck={false}
      />
      <ul className="vocab-list">
        {shown.map((v) => (
          <li key={v.id} className="vocab-item">
            <div className="vocab-head">
              <span className="vocab-word">{v.word}</span>
              <button
                type="button"
                className={`wp-speak${speakingId === v.id ? ' is-speaking' : ''}`}
                title="朗读"
                aria-label="朗读"
                onClick={() => {
                  if (speakingId === v.id) return stop()
                  setSpeakingId(v.id)
                  void speak(v.word)
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.5 6.2H5.1L8.6 3.3V12.7L5.1 9.8H2.5V6.2Z" />
                  <path className="wave" d="M10.8 5.6C11.6 6.2 12.1 7.05 12.1 8C12.1 8.95 11.6 9.8 10.8 10.4" />
                  <path className="wave wave-2" d="M12.4 3.8C13.7 4.85 14.5 6.35 14.5 8C14.5 9.65 13.7 11.15 12.4 12.2" />
                </svg>
              </button>
              <button
                type="button"
                className="vocab-remove"
                title="从生词本移除"
                aria-label="从生词本移除"
                onClick={() => onRemove(v.id)}
              >
                ×
              </button>
            </div>
            {v.meaning && <div className="vocab-meaning">{v.meaning}</div>}
            {v.context && (
              <div className="vocab-context">
                <p>{highlight(v.context, v.word)}</p>
                {v.contextZh && <p className="vocab-context-zh">{v.contextZh}</p>}
              </div>
            )}
            <div className="vocab-foot">
              {v.videoId && (
                <button type="button" className="vocab-source" onClick={() => onOpen(v.videoId!, v.startMs)}>
                  ▶ {v.title || '来源视频'}
                  {v.startMs != null && <span className="vocab-time">{formatTime(v.startMs)}</span>}
                </button>
              )}
              {v.detail && (
                <button type="button" className="vocab-more" onClick={() => setExpanded((e) => (e === v.id ? null : v.id))}>
                  {expanded === v.id ? '收起释义' : '完整释义'}
                </button>
              )}
            </div>
            {expanded === v.id && v.detail && (
              <div className="vocab-detail">
                {v.detail.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}
              </div>
            )}
          </li>
        ))}
        {!shown.length && <li className="landing-empty">没有匹配的生词</li>}
      </ul>
    </div>
  )
}

function WordPopover({
  popover,
  saved,
  onToggleSave,
  onClose,
}: {
  popover: WordClick & { text: string | null; error?: boolean }
  saved: boolean
  onToggleSave: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const word = popoverWord(popover)
  const { speak, stop, speaking } = useSpeech()

  // 换词时停止上一个词的朗读
  useEffect(() => stop, [word, stop])

  useEffect(() => {
    const el = ref.current
    const r = popover.rect
    const w = el?.offsetWidth ?? 300
    const h = el?.offsetHeight ?? 120
    let left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12)
    let top = r.bottom + 8
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8)
    setPos({ left, top })
  }, [popover])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  return (
    <div ref={ref} className="word-popover" style={{ left: pos.left, top: pos.top }} role="dialog">
      <div className="wp-head">
        <span className="wp-word">{word}</span>
        <button
          type="button"
          className={`wp-speak${speaking ? ' is-speaking' : ''}`}
          title={speaking ? '停止' : '朗读'}
          aria-label={speaking ? '停止朗读' : '朗读'}
          onClick={() => (speaking ? stop() : void speak(word))}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 6.2H5.1L8.6 3.3V12.7L5.1 9.8H2.5V6.2Z" />
            <path className="wave" d="M10.8 5.6C11.6 6.2 12.1 7.05 12.1 8C12.1 8.95 11.6 9.8 10.8 10.4" />
            <path className="wave wave-2" d="M12.4 3.8C13.7 4.85 14.5 6.35 14.5 8C14.5 9.65 13.7 11.15 12.4 12.2" />
          </svg>
        </button>
        <span className="wp-time">{formatTime(popover.cue.words[popover.index].s)}</span>
        <button
          type="button"
          className={`wp-save${saved ? ' is-on' : ''}`}
          title={saved ? '从生词本移除' : '加入生词本'}
          onClick={onToggleSave}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.8l1.85 3.86 4.2.53-3.08 2.92.79 4.17L8 11.24l-3.76 2.04.79-4.17L1.95 6.19l4.2-.53z" />
          </svg>
          {saved ? '已收藏' : '收藏'}
        </button>
      </div>
      {popover.keyword && <div className="wp-meaning">{popover.keyword.meaning}</div>}
      <div className={`wp-body${popover.error ? ' is-error' : ''}`}>
        {popover.text != null ? (
          // DeepSeek 常返回 **粗体** 标记，渲染成粗体
          popover.text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))
        ) : (
          <span className="inline-loading">
            <span className="inline-spinner" />
            查询中…
          </span>
        )}
      </div>
    </div>
  )
}
