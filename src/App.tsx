import TitleBar from './components/TitleBar'
import SettingsPanel from './components/SettingsPanel'
import BubblePanel from './components/BubblePanel'
import CaptureOverlay from './components/CaptureOverlay'

export default function App() {
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  if (hash.includes('bubble')) return <BubblePanel />
  if (hash.includes('overlay')) return <CaptureOverlay />

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="content">
        <SettingsPanel />
      </div>
    </div>
  )
}
