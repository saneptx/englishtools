import { uIOhook, UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi'

/** 划词选区（uiohook 原始屏幕坐标，主进程再转 DIP） */
export type SelectionRect = {
  x: number
  y: number
  width: number
  height: number
  endX: number
  endY: number
  cursorDip?: { x: number; y: number }
}

type SelectionHandler = (rect: SelectionRect) => void
type OutsideClickHandler = (point: { x: number; y: number }) => void
type CursorReader = () => { x: number; y: number }
type TypingHandler = () => void

let started = false
let down: { x: number; y: number } | null = null
let handler: SelectionHandler | null = null
let outsideHandler: OutsideClickHandler | null = null
let cursorReader: CursorReader | null = null
let typingHandler: TypingHandler | null = null
let enabled = true
let typingEnabled = true
let suspended = false
let busy = false
let typingTimer: ReturnType<typeof setTimeout> | null = null

const IGNORED_KEYCODES = new Set([
  15, // Tab
  29, 3613, // Ctrl
  42, 54, // Shift
  56, 3640, // Alt
  58, // CapsLock
  3675, 3676, // Meta / Win
  59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, // F1..F12
  3655, 3657, 3663, 3665, 3666, // Home, PgUp, End, PgDn, Insert
  57416, 57419, 57421, 57424, // Arrow keys
])

function clearTypingTimer() {
  if (typingTimer) {
    clearTimeout(typingTimer)
    typingTimer = null
  }
}

export function startSelectionHook(
  onSelection: SelectionHandler,
  onOutsideClick?: OutsideClickHandler,
  getCursorDip?: CursorReader,
  onTypingPause?: TypingHandler,
) {
  handler = onSelection
  outsideHandler = onOutsideClick ?? null
  cursorReader = getCursorDip ?? null
  typingHandler = onTypingPause ?? null
  if (started) return
  started = true

  uIOhook.on('mousedown', (e: UiohookMouseEvent) => {
    if (e.button !== 1) return
    clearTypingTimer()
    if (suspended) {
      down = null
      return
    }
    outsideHandler?.({ x: e.x, y: e.y })
    if (enabled) down = { x: e.x, y: e.y }
  })

  uIOhook.on('mouseup', (e: UiohookMouseEvent) => {
    if (suspended || !enabled || !handler) {
      down = null
      return
    }
    if (e.button !== 1 || !down) return
    const start = down
    down = null
    const left = Math.min(start.x, e.x)
    const top = Math.min(start.y, e.y)
    const width = Math.abs(e.x - start.x)
    const height = Math.abs(e.y - start.y)
    if (Math.hypot(width, height) < 10) return
    if (busy) return
    busy = true
    const rect: SelectionRect = {
      x: left,
      y: top,
      width: Math.max(width, 1),
      height: Math.max(height, 1),
      endX: e.x,
      endY: e.y,
      cursorDip: cursorReader?.(),
    }
    setTimeout(() => {
      if (suspended || !enabled) {
        busy = false
        return
      }
      Promise.resolve(handler?.(rect))
        .catch(() => undefined)
        .finally(() => {
          busy = false
        })
    }, 60)
  })

  uIOhook.on('keydown', (e: UiohookKeyboardEvent) => {
    if (suspended || !typingEnabled || !typingHandler) return
    if (e.keycode === 1) {
      // Escape
      clearTypingTimer()
      return
    }
    if (IGNORED_KEYCODES.has(e.keycode)) return
    if (e.altKey || e.metaKey) return
    // Ctrl 组合键仅放行 Ctrl+V (47) 与 Ctrl+X (45)
    if (e.ctrlKey && e.keycode !== 47 && e.keycode !== 45) return

    clearTypingTimer()
    typingTimer = setTimeout(() => {
      typingTimer = null
      if (suspended || !typingEnabled) return
      void Promise.resolve(typingHandler?.()).catch(() => undefined)
    }, 550)
  })

  uIOhook.start()
}

export function stopSelectionHook() {
  if (!started) return
  clearTypingTimer()
  try {
    uIOhook.stop()
  } catch {
    /* ignore */
  }
  started = false
  down = null
}

export function setSelectionHookEnabled(value: boolean) {
  enabled = value
  if (!value) down = null
}

export function setTypingHookEnabled(value: boolean) {
  typingEnabled = value
  if (!value) clearTypingTimer()
}

export function setSelectionHookSuspended(value: boolean) {
  suspended = value
  if (value) {
    down = null
    clearTypingTimer()
  }
}
