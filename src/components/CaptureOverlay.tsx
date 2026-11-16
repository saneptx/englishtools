import { useEffect, useRef, useState } from 'react'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export default function CaptureOverlay() {
  const [active, setActive] = useState(false)
  const [bg, setBg] = useState('')
  const start = useRef<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)

  useEffect(() => {
    if (!window.englishTools?.onOverlayStart) return
    const off = window.englishTools.onOverlayStart((payload) => {
      setBg(payload?.backgroundDataUrl || '')
      setActive(true)
      setRect(null)
      start.current = null
    })
    return () => off()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void window.englishTools.overlayCancel()
        setActive(false)
        setBg('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!active) return <div style={{ width: '100%', height: '100%', background: '#000' }} />

  return (
    <div
      className={`overlay-root${rect && rect.width > 0 ? ' has-rect' : ''}`}
      onMouseDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY }
        setRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
      }}
      onMouseMove={(e) => {
        if (!start.current) return
        const x = Math.min(start.current.x, e.clientX)
        const y = Math.min(start.current.y, e.clientY)
        setRect({
          x,
          y,
          width: Math.abs(e.clientX - start.current.x),
          height: Math.abs(e.clientY - start.current.y),
        })
      }}
      onMouseUp={() => {
        if (!rect || rect.width < 8 || rect.height < 8) {
          start.current = null
          setRect(null)
          return
        }
        const captureRect = { ...rect }
        start.current = null
        setRect(null)
        setActive(false)
        void window.englishTools.overlayCapture(captureRect)
      }}
    >
      {bg ? <div className="overlay-freeze" style={{ backgroundImage: `url(${bg})` }} /> : null}
      <div className="overlay-dim" />
      <div className="overlay-hint">
        拖动框选要翻译的区域<kbd>Esc</kbd>取消
      </div>
      {rect && rect.width > 0 && (
        <div
          className={`selection-rect${rect.y < 32 ? ' is-top' : ''}`}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          <span className="selection-size">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      )}
    </div>
  )
}
