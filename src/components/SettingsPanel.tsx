import { useEffect, useRef, useState, type ReactNode } from 'react'

const IS_MAC = window.englishTools?.platform === 'darwin'
const DEFAULT_HOTKEY = IS_MAC ? 'Alt+Shift+S' : 'CommandOrControl+Shift+S'
const DEFAULT_INPUT_HOTKEY = IS_MAC ? 'Alt+T' : 'Control+Alt+T'

type TextFields = {
  apiKey: string
  baseUrl: string
  model: string
  screenshotHotkey: string
  inputTranslateHotkey: string
}

const EMPTY_FIELDS: TextFields = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  screenshotHotkey: DEFAULT_HOTKEY,
  inputTranslateHotkey: DEFAULT_INPUT_HOTKEY,
}

/** 把 Electron accelerator 显示成平台习惯的按键符号 */
function formatAccelerator(accel: string): string[] {
  const map: Record<string, string> = IS_MAC
    ? {
        commandorcontrol: '⌘',
        cmdorctrl: '⌘',
        command: '⌘',
        cmd: '⌘',
        control: '⌃',
        ctrl: '⌃',
        alt: '⌥',
        option: '⌥',
        shift: '⇧',
      }
    : { commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
  return accel
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => map[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k))
}

function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  )
}

function Section({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section-title">{title}</h3>
      <div className="group">{children}</div>
      {footer && <p className="section-footer">{footer}</p>}
    </section>
  )
}

function HotkeyRow({
  title,
  desc,
  value,
  placeholder,
  onChange,
}: {
  title: string
  desc: string
  value: string
  placeholder: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="row-item">
      <div className="row-text">
        <div className="row-title">{title}</div>
        <div className="row-desc">{desc}</div>
      </div>
      <div className="hotkey-field">
        <Keys keys={formatAccelerator(value || placeholder)} />
        <input
          className="input input-compact"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          spellCheck={false}
        />
      </div>
    </label>
  )
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="keys">
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  )
}

export default function SettingsPanel() {
  const [saved, setSaved] = useState<TextFields>(EMPTY_FIELDS)
  const [fields, setFields] = useState<TextFields>(EMPTY_FIELDS)
  const [autoSelectTranslate, setAutoSelectTranslate] = useState(true)
  const [autoTypeTranslate, setAutoTypeTranslate] = useState(true)
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [perms, setPerms] = useState({ accessibility: true, screen: true })
  const [autostart, setAutostart] = useState({ supported: false, enabled: false })

  useEffect(() => {
    void window.englishTools.getAutostart().then(setAutostart)
  }, [])
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.englishTools.getSettings().then((s) => {
      const next = {
        apiKey: s.apiKey,
        baseUrl: s.baseUrl,
        model: s.model,
        screenshotHotkey: s.screenshotHotkey,
        inputTranslateHotkey: s.inputTranslateHotkey ?? DEFAULT_INPUT_HOTKEY,
      }
      setSaved(next)
      setFields(next)
      setAutoSelectTranslate(s.autoSelectTranslate !== false)
      setAutoTypeTranslate(s.autoTypeTranslate !== false)
    })
  }, [])

  useEffect(() => {
    if (!IS_MAC) return
    const refresh = () => void window.englishTools.getPermissions().then(setPerms)
    refresh()
    window.addEventListener('focus', refresh)
    const timer = setInterval(refresh, 3000)
    return () => {
      window.removeEventListener('focus', refresh)
      clearInterval(timer)
    }
  }, [])

  function flash(kind: 'ok' | 'error', text: string) {
    setStatus({ kind, text })
    if (statusTimer.current) clearTimeout(statusTimer.current)
    if (kind === 'ok') statusTimer.current = setTimeout(() => setStatus(null), 2200)
  }

  /** 开关即时生效 */
  async function toggle(key: 'autoSelectTranslate' | 'autoTypeTranslate', value: boolean) {
    if (key === 'autoSelectTranslate') setAutoSelectTranslate(value)
    else setAutoTypeTranslate(value)
    try {
      await window.englishTools.setSettings({ [key]: value })
      flash('ok', '已生效')
    } catch (e) {
      flash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const dirty = (Object.keys(fields) as (keyof TextFields)[]).some((k) => fields[k] !== saved[k])

  async function save() {
    const next: TextFields = {
      apiKey: fields.apiKey.trim(),
      baseUrl: fields.baseUrl.trim() || 'https://api.deepseek.com',
      model: fields.model.trim() || 'deepseek-chat',
      screenshotHotkey: fields.screenshotHotkey.trim(),
      inputTranslateHotkey: fields.inputTranslateHotkey.trim(),
    }
    try {
      await window.englishTools.setSettings(next)
      setSaved(next)
      setFields(next)
      flash('ok', '已保存')
    } catch (e) {
      flash('error', e instanceof Error ? e.message : String(e))
    }
  }

  const set = (key: keyof TextFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }))

  // ⌘S / Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const missingPerms = IS_MAC && (!perms.accessibility || !perms.screen)
  const alt = IS_MAC ? '⌥' : 'Alt'

  return (
    <div className="settings">
      <div className="settings-scroll">
        <header className="hero">
          <div className="hero-icon" aria-hidden="true">
            <span>En</span>
          </div>
          <div>
            <h1>English Tools</h1>
            <p>划词翻译 · 打字译英 · 截图翻译</p>
          </div>
        </header>

        {missingPerms && (
          <div className="notice">
            <div className="notice-title">需要系统权限</div>
            {!perms.accessibility && (
              <div className="notice-row">
                <div>
                  <div className="notice-name">辅助功能</div>
                  <div className="notice-desc">用于划词翻译和打字译英</div>
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void window.englishTools.openPermissionSettings('accessibility')}
                >
                  去授权
                </button>
              </div>
            )}
            {!perms.screen && (
              <div className="notice-row">
                <div>
                  <div className="notice-name">屏幕录制</div>
                  <div className="notice-desc">用于截图翻译和微信打字译英，授权后需重启应用</div>
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void window.englishTools.openPermissionSettings('screen')}
                >
                  去授权
                </button>
              </div>
            )}
            <div className="notice-foot">
              <span>
                已打开开关仍提示未授权？这是更新后的新版本与旧授权不匹配：在系统设置的列表里选中 English Tools
                点「−」删除，再重新授权，然后重启应用。
              </span>
              <button
                type="button"
                className="btn btn-small secondary"
                onClick={() => void window.englishTools.relaunchApp()}
              >
                重启应用
              </button>
            </div>
          </div>
        )}

        <Section title="通用">
          <div className="row-item">
            <div className="row-text">
              <div className="row-title">开机自动启动</div>
              <div className="row-desc">
                {autostart.supported
                  ? `登录${IS_MAC ? ' Mac' : ' Windows'} 后在后台启动，常驻${IS_MAC ? '菜单栏' : '系统托盘'}`
                  : '安装正式版后可用（当前是开发模式）'}
              </div>
            </div>
            <Switch
              label="开机自动启动"
              checked={autostart.enabled}
              disabled={!autostart.supported}
              onChange={(v) => {
                setAutostart((a) => ({ ...a, enabled: v }))
                void window.englishTools
                  .setAutostart(v)
                  .then((a) => {
                    setAutostart(a)
                    flash('ok', '已生效')
                  })
                  .catch((e) => flash('error', e instanceof Error ? e.message : String(e)))
              }}
            />
          </div>
        </Section>

        <Section title="学习">
          <div className="row-item">
            <div className="row-text">
              <div className="row-title">YouTube 学习</div>
              <div className="row-desc">粘贴视频链接，生成逐词同步的双语字幕</div>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void window.englishTools.openLearn()}>
              打开
            </button>
          </div>
        </Section>

        <Section title="翻译">
          <div className="row-item">
            <div className="row-text">
              <div className="row-title">划词翻译</div>
              <div className="row-desc">选中英文后，在下方显示中文</div>
            </div>
            <Switch
              label="划词翻译"
              checked={autoSelectTranslate}
              onChange={(v) => void toggle('autoSelectTranslate', v)}
            />
          </div>
          <div className="row-item">
            <div className="row-text">
              <div className="row-title">打字译英</div>
              <div className="row-desc">
                {IS_MAC
                  ? '在输入框输入中文并停顿，自动显示英文。微信通过截屏识别输入框（需屏幕录制权限）'
                  : '在输入框输入中文并停顿，自动显示英文。微信中不支持，可用下方「翻译输入框」快捷键'}
              </div>
            </div>
            <Switch
              label="打字译英"
              checked={autoTypeTranslate}
              onChange={(v) => void toggle('autoTypeTranslate', v)}
            />
          </div>
        </Section>

        <Section
          title="快捷键"
          footer="修改后点保存生效。格式如 Alt+Shift+S、CommandOrControl+Shift+T。"
        >
          <HotkeyRow
            title="翻译输入框"
            desc="翻译当前输入框的全部内容，回车替换为译文"
            value={fields.inputTranslateHotkey}
            placeholder={DEFAULT_INPUT_HOTKEY}
            onChange={set('inputTranslateHotkey')}
          />
          <HotkeyRow
            title="截图翻译"
            desc="框选屏幕区域，识别并翻译其中的英文"
            value={fields.screenshotHotkey}
            placeholder={DEFAULT_HOTKEY}
            onChange={set('screenshotHotkey')}
          />
        </Section>

        <Section
          title="DeepSeek"
          footer={
            <>
              API Key 只保存在本机。
              <button
                type="button"
                className="link"
                onClick={() => void window.englishTools.openExternal('https://platform.deepseek.com/api_keys')}
              >
                获取 API Key
              </button>
            </>
          }
        >
          <label className="row-item row-field">
            <span className="row-title">API Key</span>
            <span className="input-with-action">
              <input
                className="input"
                type={showKey ? 'text' : 'password'}
                value={fields.apiKey}
                onChange={set('apiKey')}
                placeholder="sk-..."
                spellCheck={false}
              />
              <button
                type="button"
                className="input-action"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? '隐藏' : '显示'}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </span>
          </label>
          <label className="row-item row-field">
            <span className="row-title">Base URL</span>
            <input className="input" value={fields.baseUrl} onChange={set('baseUrl')} spellCheck={false} />
          </label>
          <label className="row-item row-field">
            <span className="row-title">模型</span>
            <input className="input" value={fields.model} onChange={set('model')} spellCheck={false} />
          </label>
        </Section>

        <Section title="译文卡片快捷键">
          <div className="row-item row-compact">
            <span className="row-title">朗读</span>
            <Keys keys={[alt, '1']} />
          </div>
          <div className="row-item row-compact">
            <span className="row-title">替换到输入框</span>
            <Keys keys={[alt, '2']} />
          </div>
          <div className="row-item row-compact">
            <span className="row-title">复制译文</span>
            <Keys keys={[alt, '3']} />
          </div>
          <div className="row-item row-compact">
            <span className="row-title">切换 / 执行</span>
            <span className="keys-group">
              <Keys keys={['Tab']} />
              <Keys keys={['←', '→']} />
              <Keys keys={[IS_MAC ? '↩' : 'Enter']} />
            </span>
          </div>
          <div className="row-item row-compact">
            <span className="row-title">关闭</span>
            <Keys keys={['Esc']} />
          </div>
        </Section>
      </div>

      <footer className="settings-footer">
        <span className={`status${status ? ` is-${status.kind}` : ''}`} role="status">
          {status?.text ?? (dirty ? '有未保存的修改' : '开关即时生效；修改文本框后点保存')}
        </span>
        <button
          type="button"
          className="btn"
          disabled={!dirty}
          title={dirty ? `保存（${IS_MAC ? '⌘' : 'Ctrl+'}S）` : '没有需要保存的修改'}
          onClick={() => void save()}
        >
          保存
        </button>
      </footer>
    </div>
  )
}
