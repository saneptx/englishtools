import { useEffect } from 'react'

const IS_MAC = window.englishTools?.platform === 'darwin'

/**
 * 两端统一为 macOS 风格：左上角红黄绿按钮 + 居中标题。
 * macOS 用系统自带按钮（hiddenInset），这里只留可拖动区域；Windows 自绘同款按钮。
 */
export default function TitleBar() {
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

  return (
    <header className="titlebar">
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
      <div className="titlebar-title">设置</div>
    </header>
  )
}
