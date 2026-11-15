export default function TitleBar() {
  return (
    <header className="titlebar">
      <div className="brand">设置</div>
      <div className="spacer" />
      <button type="button" title="最小化" onClick={() => window.englishTools?.minimize()}>
        ─
      </button>
      <button type="button" title="隐藏到托盘" onClick={() => window.englishTools?.closeWindow()}>
        ×
      </button>
    </header>
  )
}
