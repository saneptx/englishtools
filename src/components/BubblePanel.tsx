import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const ALT = window.englishTools?.platform === 'darwin' ? '⌥' : 'Alt+'

export default function BubblePanel() {
  const [source, setSource] = useState('')
  const [translation, setTranslation] = useState('')
  const [mode, setMode] = useState<'selection' | 'screenshot' | 'typing'>('selection')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)
  const [replaced, setReplaced] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [revision, setRevision] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastSize = useRef({ width: 0, height: 0 })
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speakSeqRef = useRef(0)
  const actionHandlersRef = useRef<{
    speak: () => void
    replace: () => void
    copy: () => void
  }>({
    speak: () => undefined,
    replace: () => undefined,
    copy: () => undefined,
  })

  const stopSpeech = useCallback(() => {
    speakSeqRef.current += 1
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    setSpeaking(false)
  }, [])

  const syncSize = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = Math.ceil(rect.width)
    const height = Math.ceil(rect.height)
    if (width <= 2 || height <= 2) return
    if (lastSize.current.width === width && lastSize.current.height === height) return
    lastSize.current = { width, height }
    void window.englishTools.resizeBubble({ width, height })
  }, [])

  useEffect(() => {
    const offUpdate = window.englishTools.onBubbleUpdate((payload) => {
      stopSpeech()
      lastSize.current = { width: 0, height: 0 }
      const nextMode = payload.mode || 'selection'
      setSource(payload.source || '')
      setTranslation(payload.translation || '')
      setMode(nextMode)
      setLoading(!!payload.loading)
      setError(!!payload.error)
      setCopied(false)
      setReplaced(false)
      setSelectedIndex(nextMode === 'typing' ? 1 : 0)
      setRevision((r) => r + 1)

      if (!payload.loading && !payload.error) {
        const englishToPreload =
          nextMode === 'typing' ? payload.translation?.trim() : payload.source?.trim()
        if (englishToPreload) {
          void window.englishTools.speakText(englishToPreload).catch(() => undefined)
        }
      }
    })
    const offHide = window.englishTools.onBubbleHide?.(() => {
      stopSpeech()
    })
    return () => {
      offUpdate()
      offHide?.()
      stopSpeech()
    }
  }, [stopSpeech])

  useLayoutEffect(() => {
    syncSize()
  }, [syncSize, source, translation, mode, loading, error, copied, replaced, speaking, selectedIndex, revision])

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => syncSize())
    observer.observe(el)
    return () => observer.disconnect()
  }, [syncSize])

  const copy = useCallback(async () => {
    if (!translation || loading) return
    await window.englishTools.copyText(translation)
    setCopied(true)
  }, [translation, loading])

  const replaceInInput = useCallback(async () => {
    if (!translation || loading || replaced) return
    const ok = await window.englishTools.replaceInputText(translation)
    if (ok) {
      setReplaced(true)
      setTimeout(() => {
        void window.englishTools.hideBubble()
      }, 350)
    }
  }, [translation, loading, replaced])

  const speakWithSystemTts = useCallback((text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setSpeaking(false)
      return
    }
    window.speechSynthesis.cancel()
    const clean = text.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim()
    const utter = new SpeechSynthesisUtterance(clean)
    utter.lang = 'en-US'
    utter.rate = 0.95
    const voices = window.speechSynthesis.getVoices()
    const enVoice =
      voices.find((v) => /^en(-|_)/i.test(v.lang) && /natural|online|aria|jenny|zira|david/i.test(v.name)) ||
      voices.find((v) => /^en(-|_)/i.test(v.lang))
    if (enVoice) utter.voice = enVoice
    utter.onend = () => setSpeaking(false)
    utter.onerror = () => setSpeaking(false)
    setSpeaking(true)
    window.speechSynthesis.speak(utter)
  }, [])

  const toggleSpeak = useCallback(async () => {
    if (speaking) {
      stopSpeech()
      return
    }
    const text = (mode === 'typing' ? translation : source || translation).trim()
    if (!text || loading) return

    stopSpeech()
    const seq = ++speakSeqRef.current
    setSpeaking(true)

    try {
      const dataUrl = await window.englishTools.speakText(text)
      if (seq !== speakSeqRef.current) return
      if (!dataUrl) {
        speakWithSystemTts(text)
        return
      }
      const audio = new Audio(dataUrl)
      audioRef.current = audio
      audio.onended = () => {
        if (audioRef.current === audio) audioRef.current = null
        setSpeaking(false)
      }
      audio.onerror = () => {
        if (audioRef.current === audio) audioRef.current = null
        if (seq === speakSeqRef.current) speakWithSystemTts(text)
      }
      await audio.play()
    } catch {
      if (seq === speakSeqRef.current) {
        speakWithSystemTts(text)
      }
    }
  }, [speaking, stopSpeech, mode, translation, source, loading, speakWithSystemTts])

  useEffect(() => {
    actionHandlersRef.current = {
      speak: () => void toggleSpeak(),
      replace: () => void replaceInInput(),
      copy: () => void copy(),
    }
  }, [toggleSpeak, replaceInInput, copy])

  useEffect(() => {
    if (!window.englishTools.onBubbleAction) return
    const off = window.englishTools.onBubbleAction((action) => {
      if (action === 'prev') {
        setSelectedIndex((i) => (i + 2) % 3)
      } else if (action === 'next') {
        setSelectedIndex((i) => (i + 1) % 3)
      } else if (action === 'confirm') {
        setSelectedIndex((cur) => {
          if (cur === 0) actionHandlersRef.current.speak()
          else if (cur === 1) actionHandlersRef.current.replace()
          else actionHandlersRef.current.copy()
          return cur
        })
      } else if (action === 'speak') {
        setSelectedIndex(0)
        actionHandlersRef.current.speak()
      } else if (action === 'replace') {
        setSelectedIndex(1)
        actionHandlersRef.current.replace()
      } else if (action === 'copy') {
        setSelectedIndex(2)
        actionHandlersRef.current.copy()
      }
    })
    return () => off()
  }, [])

  return (
    <div className="bubble-stage" ref={rootRef}>
      <div
        className={`inline-bar${error ? ' is-error' : ''}${loading ? ' is-loading' : ''}`}
        onMouseEnter={() => void window.englishTools.setBubbleIgnoreMouse(false)}
        onMouseLeave={() => void window.englishTools.setBubbleIgnoreMouse(true)}
      >
        {loading ? (
          <span className="inline-loading">
            <span className="inline-spinner" />
            <span>翻译中…</span>
          </span>
        ) : (
          <span className="inline-bar-text">{translation}</span>
        )}
        {!loading && !error && translation && (
          <div className="inline-actions">
            <button
              type="button"
              className={`inline-copy inline-speak${speaking ? ' is-speaking' : ''}${selectedIndex === 0 ? ' is-selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(0)}
              onClick={() => void toggleSpeak()}
              title={`朗读 (${ALT}1)`}
              aria-label="朗读"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2.5 6.2H5.1L8.6 3.3V12.7L5.1 9.8H2.5V6.2Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
                <path
                  d="M10.8 5.6C11.6 6.2 12.1 7.05 12.1 8C12.1 8.95 11.6 9.8 10.8 10.4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                {speaking && (
                  <path
                    d="M12.4 3.8C13.7 4.85 14.5 6.35 14.5 8C14.5 9.65 13.7 11.15 12.4 12.2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
            <button
              type="button"
              className={`inline-copy${replaced ? ' is-copied' : ''}${selectedIndex === 1 ? ' is-selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(1)}
              onClick={() => void replaceInInput()}
              title={`替换/粘贴到输入框 (${ALT}2)`}
              aria-label="替换"
            >
              {replaced ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3.5 8.5L6.5 11.5L12.5 4.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 8H12.5M12.5 8L9 4.5M12.5 8L9 11.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`inline-copy${copied ? ' is-copied' : ''}${selectedIndex === 2 ? ' is-selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(2)}
              onClick={() => void copy()}
              title={`复制译文 (${ALT}3)`}
              aria-label="复制"
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3.5 8.5L6.5 11.5L12.5 4.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect
                    x="5.5"
                    y="5.5"
                    width="8"
                    height="8"
                    rx="1.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M10.5 5.5V3.8C10.5 3.08 9.92 2.5 9.2 2.5H3.8C3.08 2.5 2.5 3.08 2.5 3.8V9.2C2.5 9.92 3.08 10.5 3.8 10.5H5.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
