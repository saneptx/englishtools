import { useEffect, useRef } from 'react'

const IS_MAC = window.englishTools?.platform === 'darwin'

/**
 * 两端统一为 macOS 风格：左上角红黄绿按钮 + 居中标题。
 * macOS 用系统自带按钮（hiddenInset），这里只留可拖动区域；Windows 自绘同款按钮。
 */
export default function TitleBar({ title = '设置' }: { title?: string }) {
  useEffect(() => {
    if (IS_MAC) return
    const sync = () => document.body.classList.toggle('is-blurred', !document.hasFocus())
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
    }
  }, [])

  // macOS 27 上系统的「可拖动区域」(-webkit-app-region: drag) 经常失效，改为自己移动窗口
  const drag = useRef<{ x: number; y: number; raf: number; dx: number; dy: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!IS_MAC || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.screenX, y: e.screenY, raf: 0, dx: 0, dy: 0 }
    window.englishTools.windowDragStart()
  }
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    d.dx = e.screenX - d.x
    d.dy = e.screenY - d.y
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0
        window.englishTools.windowDragMove(d.dx, d.dy)
      })
    }
  }
  const endDrag = () => {
    if (drag.current?.raf) cancelAnimationFrame(drag.current.raf)
    if (drag.current) window.englishTools.windowDragMove(drag.current.dx, drag.current.dy)
    drag.current = null
  }

  return (
    <header
      className={`titlebar${IS_MAC ? ' is-mac' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // 与系统一致：双击标题栏缩放窗口
      onDoubleClick={(e) => {
        if (IS_MAC && !(e.target as HTMLElement).closest('button')) window.englishTools.toggleMaximize()
      }}
    >
      {!IS_MAC && (
        <div className="traffic-lights">
          <button
            type="button"
            className="light light-close"
            title="隐藏到托盘"
            aria-label="隐藏到托盘"
            onClick={() => window.englishTools?.closeWindow()}
          >
            <svg viewBox="0 0 8 8" aria-hidden="true">
              <path d="M1.8 1.8l4.4 4.4M6.2 1.8L1.8 6.2" />
            </svg>
          </button>
          <button
            type="button"
            className="light light-min"
            title="最小化"
            aria-label="最小化"
            onClick={() => window.englishTools?.minimize()}
          >
            <svg viewBox="0 0 8 8" aria-hidden="true">
              <path d="M1.5 4h5" />
            </svg>
          </button>
          <button
            type="button"
            className="light light-max"
            title="最大化 / 还原"
            aria-label="最大化 / 还原"
            onClick={() => window.englishTools?.toggleMaximize()}
          >
            <svg viewBox="0 0 8 8" aria-hidden="true">
              <path d="M2 4.8V2h2.8M6 3.2V6H3.2" />
            </svg>
          </button>
        </div>
      )}
      <div className="titlebar-title">{title}</div>
    </header>
  )
}
