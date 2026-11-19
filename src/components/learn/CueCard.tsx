import { memo, useMemo } from 'react'
import type { SubtitleCue } from '../../../electron/preload'

export function formatTime(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/'/g, '')

/** 每个词属于哪个重点词（短语按连续词匹配），返回 词序号 → 释义 */
function keywordMap(cue: SubtitleCue): Map<number, { word: string; meaning: string }> {
  const map = new Map<number, { word: string; meaning: string }>()
  const tokens = cue.words.map((w) => norm(w.t))
  for (const kw of cue.keywords || []) {
    const parts = kw.word.split(/\s+/).map(norm).filter(Boolean)
    if (!parts.length) continue
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      if (parts.every((p, k) => tokens[i + k] === p)) {
        for (let k = 0; k < parts.length; k++) map.set(i + k, kw)
        break
      }
    }
  }
  return map
}

export interface WordClick {
  cue: SubtitleCue
  index: number
  keyword?: { word: string; meaning: string }
  rect: DOMRect
}

interface Props {
  cue: SubtitleCue
  active: boolean
  /** 仅当前句有效：正在读的词序号，-1 表示还没开始 */
  wordIndex: number
  showZh: boolean
  favorite: boolean
  /** 已收藏的生词（norm 后），在字幕里加下划线标出 */
  savedWords: Set<string>
  onSeek: (cue: SubtitleCue) => void
  onWord: (w: WordClick) => void
  onFavorite: (cue: SubtitleCue) => void
}

function CueCardImpl({ cue, active, wordIndex, showZh, favorite, savedWords, onSeek, onWord, onFavorite }: Props) {
  const kw = useMemo(() => keywordMap(cue), [cue])

  return (
    <article
      className={`cue${active ? ' is-active' : ''}`}
      data-cue-id={cue.id}
      onClick={() => onSeek(cue)}
    >
      <header className="cue-head">
        <span className="cue-time">{formatTime(cue.startMs)}</span>
        <button
          type="button"
          className={`cue-fav${favorite ? ' is-on' : ''}`}
          aria-label={favorite ? '取消收藏' : '收藏'}
          title={favorite ? '取消收藏' : '收藏这句'}
          onClick={(e) => {
            e.stopPropagation()
            onFavorite(cue)
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20.3l-1.2-1.1C6.2 15.1 3.2 12.4 3.2 9A4.6 4.6 0 0 1 7.8 4.4c1.6 0 3.1.7 4.2 1.9a5.6 5.6 0 0 1 4.2-1.9A4.6 4.6 0 0 1 20.8 9c0 3.4-3 6.1-7.6 10.2z" />
          </svg>
        </button>
      </header>
      <p className="cue-en">
        {cue.words.map((w, i) => {
          const k = kw.get(i)
          let state = ''
          if (active) state = i < wordIndex ? ' is-past' : i === wordIndex ? ' is-current' : ' is-future'
          // 标点不参与高亮 / 描边
          const [, lead, core, trail] = w.t.match(/^([^\w']*)(.*?)([^\w']*)$/) || ['', '', w.t, '']
          return (
            <span key={i} className={`wp${active ? state.replace('is-current', 'is-past') : ''}`}>
              {lead}
              <span
                className={`w${state}${k ? ' is-kw' : ''}${savedWords.has(norm(w.t)) ? ' is-saved' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onWord({ cue, index: i, keyword: k, rect: e.currentTarget.getBoundingClientRect() })
                }}
              >
                {core || w.t}
              </span>
              {trail}{' '}
            </span>
          )
        })}
      </p>
      {showZh &&
        (cue.zh ? (
          <p className="cue-zh">{cue.zh}</p>
        ) : (
          <p className="cue-zh is-pending" aria-label="翻译中">
            <span className="shimmer" />
          </p>
        ))}
    </article>
  )
}

export const CueCard = memo(CueCardImpl)
