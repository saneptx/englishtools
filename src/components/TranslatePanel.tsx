import { useCallback, useEffect, useRef, useState } from 'react'

export default function TranslatePanel() {
  const [cnInput, setCnInput] = useState('')
  const [enLive, setEnLive] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoOn, setAutoOn] = useState(true)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const req = useRef(0)

  useEffect(() => {
    void window.englishTools.getSettings().then((s) => {
      setAutoOn(s.autoSelectTranslate !== false)
    })
  }, [])

  const runZhEn = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      setEnLive('')
      setError('')
      setLoading(false)
      return
    }
    const id = ++req.current
    setLoading(true)
    setError('')
    try {
      const out = await window.englishTools.translate(trimmed, 'zh-en')
      if (id !== req.current) return
      setEnLive(out)
    } catch (e) {
      if (id !== req.current) return
      setError(e instanceof Error ? e.message : String(e))
      setEnLive('')
    } finally {
      if (id === req.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void runZhEn(cnInput)
    }, 450)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [cnInput, runZhEn])

  return (
    <div className="panel translate-page">
      <section className="block">
        <h2>系统划词英译汉</h2>
        <p className="hint">
          在电脑任意软件里用鼠标拖选英文，松手后会在选区附近弹出中文译文。应用会在托盘后台运行。
          当前：{autoOn ? '已开启' : '已关闭'}（可在设置或托盘菜单切换）。
        </p>
      </section>

      <section className="block">
        <h2>输入汉译英</h2>
        <p className="hint">输入中文，下方实时显示英文。</p>
        <div className="field">
          <label>中文</label>
          <textarea
            value={cnInput}
            onChange={(e) => setCnInput(e.target.value)}
            placeholder="在这里输入中文…"
            rows={4}
          />
        </div>
        <div className="live-en">
          <div className="label">英文</div>
          {loading && <div className="loading">翻译中…</div>}
          {error && <div className="error">{error}</div>}
          {!error && enLive && <div className="live-en-text">{enLive}</div>}
          {!loading && !error && !enLive && <div className="hint">译文将显示在这里</div>}
        </div>
        {enLive && (
          <button
            type="button"
            className="btn secondary"
            onClick={() => void navigator.clipboard.writeText(enLive)}
          >
            复制英文
          </button>
        )}
      </section>
    </div>
  )
}
