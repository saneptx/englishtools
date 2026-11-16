import TitleBar from './components/TitleBar'
import SettingsPanel from './components/SettingsPanel'
import BubblePanel from './components/BubblePanel'
import CaptureOverlay from './components/CaptureOverlay'
import LearnWindow from './components/learn/LearnWindow'

export default function App() {
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  if (hash.includes('bubble')) return <BubblePanel />
  if (hash.includes('overlay')) return <CaptureOverlay />
  if (hash.includes('learn')) return <LearnWindow />

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="content">
        <SettingsPanel />
      </div>
    </div>
  )
}
