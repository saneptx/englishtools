import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  shell,
  clipboard,
  globalShortcut,
  desktopCapturer,
  type NativeImage,
  type Rectangle,
} from 'electron'
import path from 'node:path'
import {
  getSettings,
  setSettings,
  type AppSettings,
} from './services/store'
import { translate } from './services/deepseek'
import { captureSelectedText } from './services/clipboard'
import { ocrFromDataUrl } from './services/ocr'
import { synthesizeEdgeTts } from './services/tts'
import { readFocusedInput, replaceFocusedInputText } from './services/inputMonitor'
import { type ScreenRect } from './services/selectionBounds'
import {
  startSelectionHook,
  stopSelectionHook,
  setSelectionHookEnabled,
  setTypingHookEnabled,
  setSelectionHookSuspended,
  type SelectionRect,
} from './services/selectionHook'

const SHADOW_PAD_X = 14
const SHADOW_PAD_TOP = 6
const SHADOW_PAD_BOTTOM = 18
const BUBBLE_MIN_WIDTH = 96
const BUBBLE_MAX_WIDTH = 668
const BUBBLE_MIN_HEIGHT = 56
const BUBBLE_MAX_HEIGHT = 260

let mainWindow: BrowserWindow | null = null
let bubbleWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let translating = false
let screenshotActive = false
let ignoreSelectionUntil = 0
let activeTaskSeq = 0
let rebuildTray: () => void = () => undefined
/** 划词过程中忽略外部点击，避免刚显示就被关掉 */
let ignoreOutsideUntil = 0
let lastBubbleAnchor: ScreenRect | null = null
let lastBubbleMode: 'selection' | 'screenshot' | 'typing' = 'selection'
let lastTypedSourceText = ''
let registeredScreenshotHotkey = ''
const activeBubbleShortcuts = new Set<string>()
let pendingCaptureImage: NativeImage | null = null
let pendingCaptureScale = 1
let overlayBounds: Rectangle | null = null

const isDev = !!process.env.VITE_DEV_SERVER_URL

function preloadPath() {
  return path.join(__dirname, 'preload.js')
}

function rendererUrl(hash = '') {
  if (isDev) return `${process.env.VITE_DEV_SERVER_URL}${hash}`
  const file = path.join(__dirname, '../dist/index.html')
  return hash ? `file://${file}${hash}` : `file://${file}`
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 560,
    minWidth: 380,
    minHeight: 420,
    show: false,
    frame: false,
    backgroundColor: '#0f1419',
    skipTaskbar: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.loadURL(rendererUrl())
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
  mainWindow?.show()
  mainWindow?.focus()
}

function createBubbleWindow() {
  // 透明轻量层：贴在选区下方显示带阴影的白底卡片
  bubbleWindow = new BrowserWindow({
    width: 300,
    height: 64,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: false,
    thickFrame: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  bubbleWindow.setAlwaysOnTop(true, 'screen-saver')
  bubbleWindow.setIgnoreMouseEvents(true, { forward: true })
  bubbleWindow.loadURL(rendererUrl('#/bubble'))
  bubbleWindow.on('closed', () => {
    bubbleWindow = null
  })
}

function ensureBubble(): BrowserWindow {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) createBubbleWindow()
  return bubbleWindow!
}

function bindBubbleShortcut(accel: string, fn: () => void) {
  if (activeBubbleShortcuts.has(accel)) return
  try {
    if (globalShortcut.register(accel, fn)) {
      activeBubbleShortcuts.add(accel)
    }
  } catch {
    /* ignore */
  }
}

function unregisterBubbleShortcuts() {
  for (const accel of activeBubbleShortcuts) {
    try {
      globalShortcut.unregister(accel)
    } catch {
      /* ignore */
    }
  }
  activeBubbleShortcuts.clear()
}

function sendBubbleAction(action: 'prev' | 'next' | 'confirm' | 'speak' | 'replace' | 'copy') {
  if (!bubbleWindow || bubbleWindow.isDestroyed() || !bubbleWindow.isVisible()) return
  bubbleWindow.webContents.send('bubble-action', action)
}

function enableBubbleArrowConfirm() {
  bindBubbleShortcut('Left', () => sendBubbleAction('prev'))
  bindBubbleShortcut('Right', () => sendBubbleAction('next'))
  bindBubbleShortcut('Enter', () => sendBubbleAction('confirm'))
}

function registerBubbleShortcuts(mode: 'selection' | 'screenshot' | 'typing') {
  unregisterBubbleShortcuts()
  bindBubbleShortcut('Alt+1', () => sendBubbleAction('speak'))
  bindBubbleShortcut('Alt+2', () => sendBubbleAction('replace'))
  bindBubbleShortcut('Alt+3', () => sendBubbleAction('copy'))
  bindBubbleShortcut('Alt+Left', () => {
    enableBubbleArrowConfirm()
    sendBubbleAction('prev')
  })
  bindBubbleShortcut('Alt+Right', () => {
    enableBubbleArrowConfirm()
    sendBubbleAction('next')
  })
  bindBubbleShortcut('Alt+Enter', () => sendBubbleAction('confirm'))
  bindBubbleShortcut('Tab', () => {
    enableBubbleArrowConfirm()
    sendBubbleAction('next')
  })
  bindBubbleShortcut('Escape', () => hideInlineTranslation())

  if (mode !== 'typing') {
    enableBubbleArrowConfirm()
  }
}

function hideInlineTranslation() {
  unregisterBubbleShortcuts()
  lastBubbleAnchor = null
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.webContents.send('bubble-hide')
    bubbleWindow.hide()
  }
}

function toDipPoint(point: { x: number; y: number }) {
  try {
    return screen.screenToDipPoint({
      x: Math.round(point.x),
      y: Math.round(point.y),
    })
  } catch {
    const factor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor || 1
    return { x: point.x / factor, y: point.y / factor }
  }
}

function isHookPointPhysical(
  rawPoint: { x: number; y: number },
  cursorDip: { x: number; y: number },
): boolean {
  try {
    const cursorPhys = screen.dipToScreenPoint({
      x: Math.round(cursorDip.x),
      y: Math.round(cursorDip.y),
    })
    const distDip = Math.hypot(rawPoint.x - cursorDip.x, rawPoint.y - cursorDip.y)
    const distPhys = Math.hypot(rawPoint.x - cursorPhys.x, rawPoint.y - cursorPhys.y)
    return distPhys + 2 < distDip
  } catch {
    const endDip = toDipPoint(rawPoint)
    const rawDist = Math.hypot(rawPoint.x - cursorDip.x, rawPoint.y - cursorDip.y)
    const dipDist = Math.hypot(endDip.x - cursorDip.x, endDip.y - cursorDip.y)
    return dipDist + 2 < rawDist
  }
}

/** 用松手点对齐光标，整段选区只用同一种坐标，避免起点被误缩放 */
function hookRectToDip(rect: SelectionRect, cursorDip?: { x: number; y: number }): ScreenRect {
  const cursor = cursorDip ?? screen.getCursorScreenPoint()
  const asPhysical = isHookPointPhysical({ x: rect.endX, y: rect.endY }, cursor)
  const conv = (x: number, y: number) => (asPhysical ? toDipPoint({ x, y }) : { x, y })
  const tl = conv(rect.x, rect.y)
  const br = conv(rect.x + rect.width, rect.y + rect.height)
  return {
    x: Math.min(tl.x, br.x),
    y: Math.min(tl.y, br.y),
    width: Math.max(1, Math.abs(br.x - tl.x)),
    height: Math.max(1, Math.abs(br.y - tl.y)),
  }
}

/** 拖拽过扁时补成一行字高，让底边落在文字下方 */
function expandToTextLine(rect: ScreenRect): ScreenRect {
  if (rect.height >= 16) return rect
  const mid = rect.y + rect.height / 2
  const line = 22
  return { x: rect.x, y: mid - line / 2, width: rect.width, height: line }
}

/** 把译文卡片放在给定 DIP 矩形的正下方（扣除阴影留白使卡片可视边缘对齐选区） */
function placeBelowDipRect(
  rect: ScreenRect,
  contentWidth = 0,
  contentHeight = 60,
) {
  lastBubbleAnchor = rect
  const win = ensureBubble()
  const anchor = { x: rect.x + rect.width / 2, y: rect.y + rect.height }
  const display = screen.getDisplayNearestPoint(anchor)
  const { width: dw, height: dh, x: dx, y: dy } = display.workArea
  const gap = 4
  const maxW = Math.min(BUBBLE_MAX_WIDTH, dw - 8)
  const bw = Math.min(Math.max(contentWidth || 168, BUBBLE_MIN_WIDTH), maxW)
  const bh = Math.max(BUBBLE_MIN_HEIGHT, Math.min(BUBBLE_MAX_HEIGHT, contentHeight))
  let x = rect.x - SHADOW_PAD_X
  let y = rect.y + Math.max(rect.height, 0) + gap - SHADOW_PAD_TOP
  if (x + bw - SHADOW_PAD_X > dx + dw - 6) x = dx + dw - bw + SHADOW_PAD_X - 6
  if (x + SHADOW_PAD_X < dx + 6) x = dx + 6 - SHADOW_PAD_X
  if (y + bh - SHADOW_PAD_BOTTOM > dy + dh - 4) {
    y = Math.max(dy + 4 - SHADOW_PAD_TOP, rect.y - gap - bh + SHADOW_PAD_BOTTOM)
  }
  if (y + SHADOW_PAD_TOP < dy + 4) y = dy + 4 - SHADOW_PAD_TOP
  win.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(bw),
    height: Math.round(bh),
  })
}

function hookPointToDip(point: { x: number; y: number }, cursorDip?: { x: number; y: number }) {
  const cursor = cursorDip ?? screen.getCursorScreenPoint()
  return isHookPointPhysical(point, cursor) ? toDipPoint(point) : point
}

async function showInlineResult(payload: {
  source: string
  translation: string
  loading?: boolean
  error?: boolean
  mode?: 'selection' | 'screenshot' | 'typing'
}) {
  const win = ensureBubble()
  const mode = payload.mode || 'selection'
  lastBubbleMode = mode
  ignoreOutsideUntil = Date.now() + 600
  const send = () => win.webContents.send('bubble-update', payload)
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send)
  } else {
    send()
  }
  if (!win.isVisible()) win.showInactive()
  if (!payload.loading && !payload.error && payload.translation) {
    registerBubbleShortcuts(mode)
  } else {
    unregisterBubbleShortcuts()
  }
}

/** 根据译文估算初始尺寸并贴在锚点矩形下方展示 */
async function showTranslationResult(
  anchor: ScreenRect,
  source: string,
  translation: string,
  mode: 'selection' | 'screenshot' | 'typing' = 'selection',
) {
  const approxWidth = Math.min(BUBBLE_MAX_WIDTH, Math.max(168, translation.length * 15 + 124))
  const approxHeight = Math.min(
    BUBBLE_MAX_HEIGHT,
    Math.max(64, Math.ceil(translation.length / 28) * 23 + 42),
  )
  placeBelowDipRect(anchor, approxWidth, approxHeight)
  await showInlineResult({ source, translation, mode })
}

function isPointOverOurWindows(point: { x: number; y: number }) {
  for (const win of [bubbleWindow, mainWindow]) {
    if (!win || win.isDestroyed() || !win.isVisible()) continue
    const b = win.getBounds()
    if (
      point.x >= b.x &&
      point.x <= b.x + b.width &&
      point.y >= b.y &&
      point.y <= b.y + b.height
    ) {
      return true
    }
  }
  return false
}

async function onGlobalSelection(rawRect: SelectionRect) {
  if (screenshotActive || Date.now() < ignoreSelectionUntil) return
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) return
  const settings = getSettings()
  if (!settings.autoSelectTranslate) return
  const cursor = rawRect.cursorDip ?? screen.getCursorScreenPoint()
  const dipEnd = hookPointToDip({ x: rawRect.endX, y: rawRect.endY }, cursor)
  if (isPointOverOurWindows(cursor) || isPointOverOurWindows(dipEnd)) {
    return
  }
  if (translating) return

  const seq = ++activeTaskSeq
  translating = true
  ignoreOutsideUntil = Date.now() + 600
  const anchor = expandToTextLine(hookRectToDip(rawRect, cursor))
  try {
    const text = await captureSelectedText()
    if (seq !== activeTaskSeq || screenshotActive) return
    if (!text) return
    if (!/[A-Za-z\u00C0-\u024F]/.test(text)) return

    placeBelowDipRect(anchor, 88, 36)
    await showInlineResult({ source: text, translation: '…', loading: true, mode: 'selection' })
    const translation = await translate(text, 'en-zh')
    if (seq !== activeTaskSeq || screenshotActive) return
    await showTranslationResult(anchor, text, translation, 'selection')
  } catch (err) {
    if (seq !== activeTaskSeq || screenshotActive) return
    const msg = err instanceof Error ? err.message : String(err)
    placeBelowDipRect(anchor, 240, 36)
    await showInlineResult({ source: '', translation: msg, error: true, mode: 'selection' })
  } finally {
    if (seq === activeTaskSeq) {
      translating = false
    }
  }
}

async function onGlobalTypingPause() {
  if (screenshotActive || Date.now() < ignoreSelectionUntil) return
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) return
  const settings = getSettings()
  if (settings.autoTypeTranslate === false) return
  if (translating) return

  const info = await readFocusedInput(process.pid)
  if (!info || !info.text) {
    if (lastBubbleMode === 'typing' && bubbleWindow?.isVisible()) {
      lastTypedSourceText = ''
      hideInlineTranslation()
    }
    return
  }

  // 仅当输入框中包含已上屏的中文字符时触发汉译英（忽略未上屏拼音或纯英文输入）
  if (!/[\u4e00-\u9fff]/.test(info.text)) {
    return
  }

  if (info.text === lastTypedSourceText && bubbleWindow?.isVisible()) {
    return
  }

  const seq = ++activeTaskSeq
  translating = true
  lastTypedSourceText = info.text
  ignoreOutsideUntil = Date.now() + 600
  const anchor = expandToTextLine(info.rect)

  try {
    placeBelowDipRect(anchor, 116, 60)
    await showInlineResult({
      source: info.text,
      translation: '…',
      loading: true,
      mode: 'typing',
    })
    const translation = await translate(info.text, 'zh-en')
    if (seq !== activeTaskSeq || screenshotActive) return
    await showTranslationResult(anchor, info.text, translation, 'typing')
  } catch (err) {
    if (seq !== activeTaskSeq || screenshotActive) return
    const msg = err instanceof Error ? err.message : String(err)
    placeBelowDipRect(anchor, 240, 60)
    await showInlineResult({ source: '', translation: msg, error: true, mode: 'typing' })
  } finally {
    if (seq === activeTaskSeq) {
      translating = false
    }
  }
}

function createOverlayWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  overlayWindow = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreen: false,
    hasShadow: false,
    show: false,
    focusable: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.loadURL(rendererUrl('#/overlay'))
  overlayWindow.on('closed', () => {
    overlayWindow = null
    if (!translating) {
      screenshotActive = false
      setSelectionHookSuspended(false)
    }
  })
}

function ensureOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow()
  return overlayWindow!
}

async function captureDisplayShot() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const scale = display.scaleFactor
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.floor(display.size.width * scale),
      height: Math.floor(display.size.height * scale),
    },
  })
  const source =
    sources.find((s) => s.display_id === String(display.id)) || sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法截取屏幕')
  return { image: source.thumbnail, scale, bounds: display.bounds }
}

async function startScreenshotTranslate() {
  const seq = ++activeTaskSeq
  screenshotActive = true
  setSelectionHookSuspended(true)
  try {
    hideInlineTranslation()
    mainWindow?.hide()
    await new Promise((r) => setTimeout(r, 80))
    if (seq !== activeTaskSeq) return
    const shot = await captureDisplayShot()
    if (seq !== activeTaskSeq) return
    pendingCaptureImage = shot.image
    pendingCaptureScale = shot.scale
    overlayBounds = shot.bounds
    const overlay = ensureOverlay()
    overlay.setBounds(shot.bounds)
    const dataUrl = shot.image.toDataURL()
    const start = () => {
      overlay.show()
      overlay.focus()
      overlay.webContents.send('overlay-start', { backgroundDataUrl: dataUrl })
    }
    if (overlay.webContents.isLoading()) overlay.webContents.once('did-finish-load', start)
    else start()
  } catch (err) {
    screenshotActive = false
    ignoreSelectionUntil = Date.now() + 500
    setSelectionHookSuspended(false)
    const msg = err instanceof Error ? err.message : String(err)
    const cursor = screen.getCursorScreenPoint()
    placeBelowDipRect({ x: cursor.x, y: cursor.y, width: 1, height: 1 }, 240, 36)
    await showInlineResult({ source: '', translation: msg, error: true })
  }
}

function registerHotkeys() {
  if (registeredScreenshotHotkey) {
    try {
      globalShortcut.unregister(registeredScreenshotHotkey)
    } catch {
      /* ignore */
    }
    registeredScreenshotHotkey = ''
  }
  const settings = getSettings()
  const accel = settings.screenshotHotkey?.trim()
  if (!accel) return
  try {
    if (globalShortcut.register(accel, () => void startScreenshotTranslate())) {
      registeredScreenshotHotkey = accel
    }
  } catch (err) {
    console.error('hotkey failed', accel, err)
  }
}

function createTray() {
  const iconPath = path.join(__dirname, '../assets/tray.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAASElEQVRYR+3XMQEAIAwDsHF/z0GAxMcdpJ1dTQJ4M5kAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/G3Q8gN9DwABHgABvA8BvA8B8AFYDwHwvQfYNwAAAABJRU5ErkJggg==',
    )
  }
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 })
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('English Tools · 右键打开设置')

  rebuildTray = () => {
    const s = getSettings()
    const menu = Menu.buildFromTemplate([
      {
        label: '设置',
        click: () => showMainWindow(),
      },
      {
        label: s.autoSelectTranslate ? '划词翻译：开' : '划词翻译：关',
        click: () => {
          const next = setSettings({ autoSelectTranslate: !getSettings().autoSelectTranslate })
          setSelectionHookEnabled(next.autoSelectTranslate)
          rebuildTray()
        },
      },
      {
        label: s.autoTypeTranslate !== false ? '打字译英：开' : '打字译英：关',
        click: () => {
          const cur = getSettings().autoTypeTranslate !== false
          const next = setSettings({ autoTypeTranslate: !cur })
          setTypingHookEnabled(next.autoTypeTranslate !== false)
          rebuildTray()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          stopSelectionHook()
          globalShortcut.unregisterAll()
          app.quit()
        },
      },
    ])
    tray?.setContextMenu(menu)
  }

  rebuildTray()
  tray.on('right-click', () => tray?.popUpContextMenu())
  tray.on('double-click', () => showMainWindow())
}

function registerIpc() {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, partial: Partial<AppSettings>) => {
    const next = setSettings(partial)
    if (typeof partial.autoSelectTranslate === 'boolean') {
      setSelectionHookEnabled(next.autoSelectTranslate)
    }
    if (typeof partial.autoTypeTranslate === 'boolean') {
      setTypingHookEnabled(next.autoTypeTranslate)
    }
    if (partial.screenshotHotkey !== undefined) registerHotkeys()
    rebuildTray()
    return next
  })

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text || '')
    return true
  })

  ipcMain.handle('input:replace', async (_e, text: string) => {
    if (!text) return false
    setSelectionHookSuspended(true)
    ignoreSelectionUntil = Date.now() + 800
    ignoreOutsideUntil = Date.now() + 800
    lastTypedSourceText = ''
    try {
      return await replaceFocusedInputText(text)
    } finally {
      setSelectionHookSuspended(false)
    }
  })

  ipcMain.handle('translate', async (_e, text: string, direction: 'zh-en' | 'en-zh') => {
    return translate(text, direction)
  })

  ipcMain.handle('tts:speak', async (_e, text: string) => {
    return synthesizeEdgeTts(text)
  })

  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:hide', () => mainWindow?.hide())
  ipcMain.handle('window:close', () => {
    mainWindow?.hide()
  })
  ipcMain.handle('window:open-external', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('bubble:ignore-mouse', (_e, ignore: boolean) => {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return
    if (ignore) bubbleWindow.setIgnoreMouseEvents(true, { forward: true })
    else bubbleWindow.setIgnoreMouseEvents(false)
  })

  ipcMain.handle('overlay:cancel', () => {
    activeTaskSeq++
    screenshotActive = false
    ignoreSelectionUntil = Date.now() + 500
    setSelectionHookSuspended(false)
    overlayWindow?.hide()
    pendingCaptureImage = null
  })

  ipcMain.handle(
    'overlay:capture',
    async (_e, rect: { x: number; y: number; width: number; height: number }) => {
      const seq = ++activeTaskSeq
      screenshotActive = true
      translating = true
      setSelectionHookSuspended(true)
      const origin =
        overlayWindow?.getContentBounds() ||
        overlayBounds || { x: 0, y: 0, width: 0, height: 0 }
      overlayWindow?.hide()
      const screenRect = {
        x: origin.x + rect.x,
        y: origin.y + rect.y,
        width: rect.width,
        height: rect.height,
      }
      try {
        const full = pendingCaptureImage
        const scale = pendingCaptureScale || screen.getPrimaryDisplay().scaleFactor
        pendingCaptureImage = null
        if (!full || full.isEmpty()) throw new Error('截图已失效，请重试')

        placeBelowDipRect(screenRect, 88, 36)
        await showInlineResult({ source: '', translation: '…', loading: true })

        const size = full.getSize()
        const crop = {
          x: Math.max(0, Math.min(size.width - 1, Math.floor(rect.x * scale))),
          y: Math.max(0, Math.min(size.height - 1, Math.floor(rect.y * scale))),
          width: Math.max(1, Math.floor(rect.width * scale)),
          height: Math.max(1, Math.floor(rect.height * scale)),
        }
        if (crop.x + crop.width > size.width) crop.width = size.width - crop.x
        if (crop.y + crop.height > size.height) crop.height = size.height - crop.y

        const text = await ocrFromDataUrl(full.crop(crop).toDataURL())
        if (seq !== activeTaskSeq) return { ok: false }
        if (!text) {
          placeBelowDipRect(screenRect, 220, 36)
          await showInlineResult({
            source: '',
            translation: '未识别到文字',
            error: true,
          })
          return { ok: false }
        }
        placeBelowDipRect(screenRect, 180, 36)
        await showInlineResult({ source: text, translation: '…', loading: true })
        const translation = await translate(text, 'en-zh')
        if (seq !== activeTaskSeq) return { ok: false }
        await showTranslationResult(screenRect, text, translation)
        return { ok: true }
      } catch (err) {
        if (seq !== activeTaskSeq) return { ok: false }
        const msg = err instanceof Error ? err.message : String(err)
        placeBelowDipRect(screenRect, 240, 36)
        await showInlineResult({ source: '', translation: msg, error: true })
        return { ok: false }
      } finally {
        if (seq === activeTaskSeq) {
          translating = false
          screenshotActive = false
          ignoreSelectionUntil = Date.now() + 500
          ignoreOutsideUntil = Date.now() + 600
          setSelectionHookSuspended(false)
        }
      }
    },
  )

  ipcMain.handle('bubble:hide', () => hideInlineTranslation())
  ipcMain.handle('bubble:resize', (_e, size: { width?: number; height?: number } | number) => {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return
    const cur = bubbleWindow.getBounds()
    const nextW =
      typeof size === 'number'
        ? cur.width
        : size.width
          ? Math.max(BUBBLE_MIN_WIDTH, Math.min(BUBBLE_MAX_WIDTH, Math.round(size.width)))
          : cur.width
    const nextH =
      typeof size === 'number'
        ? Math.max(BUBBLE_MIN_HEIGHT, Math.min(BUBBLE_MAX_HEIGHT, Math.round(size)))
        : size.height
          ? Math.max(BUBBLE_MIN_HEIGHT, Math.min(BUBBLE_MAX_HEIGHT, Math.round(size.height)))
          : cur.height
    if (lastBubbleAnchor) {
      placeBelowDipRect(lastBubbleAnchor, nextW, nextH)
      return
    }
    bubbleWindow.setBounds({
      ...cur,
      width: nextW,
      height: nextH,
    })
  })
}

app.whenReady().then(() => {
  createMainWindow()
  createBubbleWindow()
  createTray()
  registerIpc()

  const settings = getSettings()
  setSelectionHookEnabled(settings.autoSelectTranslate)
  setTypingHookEnabled(settings.autoTypeTranslate !== false)
  registerHotkeys()
  if (!settings.apiKey?.trim()) showMainWindow()
  try {
    startSelectionHook(
      (rect) => {
        void onGlobalSelection(rect)
      },
      (point) => {
        if (Date.now() < ignoreOutsideUntil) return
        if (!bubbleWindow?.isVisible()) return
        const p = hookPointToDip(point)
        if (isPointOverOurWindows(p)) return
        hideInlineTranslation()
      },
      () => screen.getCursorScreenPoint(),
      () => {
        void onGlobalTypingPause()
      },
    )
  } catch (err) {
    console.error('selection hook failed', err)
  }

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('will-quit', () => {
  stopSelectionHook()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // 托盘常驻，不退出；从托盘「退出」才会真正关闭
})
