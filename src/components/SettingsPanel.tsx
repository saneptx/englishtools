import { useEffect, useState } from 'react'

export default function SettingsPanel() {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com')
  const [model, setModel] = useState('deepseek-chat')
  const [screenshotHotkey, setScreenshotHotkey] = useState('CommandOrControl+Shift+S')
  const [autoSelectTranslate, setAutoSelectTranslate] = useState(true)
  const [autoTypeTranslate, setAutoTypeTranslate] = useState(true)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void window.englishTools.getSettings().then((s) => {
      setApiKey(s.apiKey)
      setBaseUrl(s.baseUrl)
      setModel(s.model)
      setScreenshotHotkey(s.screenshotHotkey)
      setAutoSelectTranslate(s.autoSelectTranslate !== false)
      setAutoTypeTranslate(s.autoTypeTranslate !== false)
    })
  }, [])

  async function save() {
    setMsg('')
    setErr('')
    try {
      await window.englishTools.setSettings({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || 'https://api.deepseek.com',
        model: model.trim() || 'deepseek-chat',
        screenshotHotkey: screenshotHotkey.trim(),
        autoSelectTranslate,
        autoTypeTranslate,
      })
      setMsg('已保存')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="panel">
      <h2>设置</h2>
      <p className="hint">右键系统托盘图标可再次打开本页。API Key 只保存在本机。</p>

      <label className="toggle-row">
        <span>划词后自动翻译</span>
        <input
          type="checkbox"
          checked={autoSelectTranslate}
          onChange={(e) => setAutoSelectTranslate(e.target.checked)}
        />
      </label>

      <label className="toggle-row">
        <span>打字时自动译英（输入法上屏后弹出）</span>
        <input
          type="checkbox"
          checked={autoTypeTranslate}
          onChange={(e) => setAutoTypeTranslate(e.target.checked)}
        />
      </label>

      <div className="field">
        <label>DeepSeek API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
      </div>

      <div className="field">
        <label>Base URL</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </div>

      <div className="field">
        <label>模型</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} />
      </div>

      <div className="field">
        <label>截图翻译快捷键</label>
        <input
          value={screenshotHotkey}
          onChange={(e) => setScreenshotHotkey(e.target.value)}
          placeholder="CommandOrControl+Shift+S"
        />
      </div>
      <p className="hint">Windows 上 CommandOrControl 即 Ctrl。例如 CommandOrControl+Shift+S。</p>

      <div className="row">
        <button type="button" className="btn" onClick={() => void save()}>
          保存
        </button>
      </div>
      {msg && <div className="success">{msg}</div>}
      {err && <div className="error">{err}</div>}
    </div>
  )
}
