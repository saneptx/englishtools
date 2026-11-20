import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * macOS 平台实现：通过 osascript + System Events 读取 Accessibility (AX) 属性、发送快捷键。
 * 需要在「系统设置 → 隐私与安全性」中授予本应用「辅助功能」权限，
 * 首次调用时系统还会弹窗请求「自动化 → System Events」权限。
 */

const execFileAsync = promisify(execFile)

/** 字段分隔符（ASCII 30），避免与正文中的换行/逗号冲突 */
const SEP = '\u001e'

/** 截图工具 / 系统 UI：在这些进程前台时不做划词 */
const SKIP_PROCESS_RE =
  /^(screencaptureui|Screenshot|截屏|截图|Snipaste|PixPin|Xnip|CleanShot X|Shottr|Dock|loginwindow|SystemUIServer|Control Center|控制中心)$/i

async function runAppleScript(script: string, timeout = 2500): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  // osascript 在结果末尾追加一个换行
  return (stdout || '').replace(/\n$/, '')
}

export type MacSelectionProbe =
  | { kind: 'abort'; app?: string }
  | { kind: 'text'; text: string; app: string }
  | { kind: 'need-copy'; app: string }

/** 读取前台应用焦点控件的 AXSelectedText；读不到时告诉调用方是否可回退 Cmd+C */
export async function macProbeSelection(): Promise<MacSelectionProbe> {
  const script = `
set sep to character id 30
tell application "System Events"
  set p to first application process whose frontmost is true
  set pn to name of p
  set t to ""
  try
    set f to value of attribute "AXFocusedUIElement" of p
    set t to value of attribute "AXSelectedText" of f
    if t is missing value then set t to ""
  end try
end tell
return pn & sep & t`

  let out: string
  try {
    out = await runAppleScript(script)
  } catch {
    return { kind: 'abort' }
  }
  const idx = out.indexOf(SEP)
  if (idx < 0) return { kind: 'abort' }
  const procName = out.slice(0, idx).trim()
  const text = out.slice(idx + 1).trim()

  if (SKIP_PROCESS_RE.test(procName)) return { kind: 'abort', app: procName }
  if (text) return { kind: 'text', text, app: procName }
  // Finder 中拖选的是文件图标，Cmd+C 会复制文件而不是文字
  if (procName === 'Finder' || procName === '访达') return { kind: 'abort', app: procName }
  return { kind: 'need-copy', app: procName }
}

/** 物理键码（ANSI 布局），不受输入法影响 */
const KEY_CODE = { a: 0, c: 8, v: 9, right: 124 } as const
type KeyName = keyof typeof KEY_CODE

/** 依次按下若干按键；`cmd:` 前缀表示同时按住 ⌘ */
export async function macSendKeys(...keys: (KeyName | `cmd:${KeyName}`)[]): Promise<void> {
  const lines = keys
    .map((k) => {
      const cmd = k.startsWith('cmd:')
      const code = KEY_CODE[(cmd ? k.slice(4) : k) as KeyName]
      return `  key code ${code}${cmd ? ' using command down' : ''}\n  delay 0.03`
    })
    .join('\n')
  await runAppleScript(`tell application "System Events"\n${lines}\nend tell`)
}

export async function macSendCommandKeys(...keys: KeyName[]): Promise<void> {
  return macSendKeys(...keys.map((k) => `cmd:${k}` as const))
}

type Rect = { x: number; y: number; width: number; height: number }

export type MacInputProbe = {
  /**
   * ok：读到可编辑控件；own：前台是本应用；nofocus：应用没有暴露焦点控件；
   * noneditable：焦点控件不是文本输入；secure：密码框；error：脚本失败
   */
  status: 'ok' | 'own' | 'nofocus' | 'noneditable' | 'secure' | 'error'
  app: string
  bundleId: string
  role: string
  text: string
  /** 焦点控件位置（读不到为 null） */
  rect: Rect | null
  /** 焦点窗口位置（读不到为 null），用于控件位置不可用时兜底 */
  windowRect: Rect | null
}

const EDITABLE_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']

/**
 * 读取前台焦点输入框。每一步单独 try，尽量多拿信息：
 * 不少跨平台框架（Qt、Chromium/Electron）的控件角色不规范或不给位置，
 * 只要控件带 AXSelectedTextRange（可编辑文本的特征）也视为输入框。
 */
export async function macProbeFocusedInput(ownPid: number): Promise<MacInputProbe> {
  const script = `
set sep to character id 30
set statusText to "ok"
set pn to ""
set bid to ""
set r to ""
set v to ""
set ep to {"", "", "", ""}
set wp to {"", "", "", ""}
try
  tell application "System Events"
    set p to first application process whose frontmost is true
    set pn to name of p
    try
      set bid to bundle identifier of p
    end try
    if (unix id of p) is ${Math.floor(ownPid)} then
      set statusText to "own"
    else
      -- Electron / Chromium 应用默认不生成无障碍树，需要显式打开
      try
        set value of attribute "AXManualAccessibility" of p to true
      end try
      try
        set w to value of attribute "AXFocusedWindow" of p
        set {wx, wy} to position of w
        set {ww, wh} to size of w
        set wp to {wx, wy, ww, wh}
      end try
      set f to missing value
      try
        set f to value of attribute "AXFocusedUIElement" of p
      end try
      if f is missing value then
        set statusText to "nofocus"
      else
        try
          set r to value of attribute "AXRole" of f
        end try
        set sr to ""
        try
          set sr to value of attribute "AXSubrole" of f
        end try
        set attrNames to {}
        try
          set attrNames to name of attributes of f
        end try
        if sr is "AXSecureTextField" then
          set statusText to "secure"
        else if r is not in {${EDITABLE_ROLES.map((x) => `"${x}"`).join(', ')}} and "AXSelectedTextRange" is not in attrNames then
          set statusText to "noneditable"
        else
          try
            set v to value of attribute "AXValue" of f
            if v is missing value then set v to ""
          end try
          try
            set {px, py} to position of f
            set {sw, sh} to size of f
            set ep to {px, py, sw, sh}
          end try
        end if
      end if
    end if
  end tell
on error errMsg
  set statusText to "error"
  set v to errMsg
end try
set AppleScript's text item delimiters to sep
set headList to {statusText, pn, bid, r} & ep & wp
return (headList as text) & sep & (v as text)`

  const fail = (status: MacInputProbe['status'], text = ''): MacInputProbe => ({
    status,
    app: '',
    bundleId: '',
    role: '',
    text,
    rect: null,
    windowRect: null,
  })

  let out: string
  try {
    out = await runAppleScript(script, 2500)
  } catch (err) {
    return fail('error', err instanceof Error ? err.message : String(err))
  }
  const parts = out.split(SEP)
  if (parts.length < 13) return fail('error', out)
  const [status, app, bundleId, role] = parts
  const num = (s: string) => Number(s.trim().replace(',', '.'))
  const toRect = (a: string[]): Rect | null => {
    const [x, y, width, height] = a.map(num)
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
    return { x, y, width, height }
  }
  return {
    status: status as MacInputProbe['status'],
    app,
    bundleId,
    role,
    rect: toRect(parts.slice(4, 8)),
    windowRect: toRect(parts.slice(8, 12)),
    text: parts.slice(12).join(SEP).trim(),
  }
}
