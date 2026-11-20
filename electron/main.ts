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
  session,
  systemPreferences,
  nativeTheme,
  type NativeImage,
  type Rectangle,
} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import {
  getSettings,
  setSettings,
  getRecentVideos,
  removeRecentVideo,
  getFavoriteCues,
  toggleFavoriteCue,
  getVocabulary,
  toggleVocabulary,
  removeVocabulary,
  updateVocabulary,
  getLearnPrefs,
  setLearnPrefs,
  type VocabItem,
  type LearnPrefs,
  type AppSettings,
  type FavoriteCue,
} from './services/store'
import { translate, lookupWord } from './services/deepseek'
import { loadLearnVideo, cancelLearnJob } from './services/learn'
import { captureSelectedText } from './services/clipboard'
import { diag } from './services/diag'
import { ocrFromDataUrl } from './services/ocr'
import { synthesizeEdgeTts } from './services/tts'
import { readFocusedInput, replaceFocusedInputText } from './services/inputMonitor'
import { macScreenOcrAvailable, warmUpMacOcr } from './services/macScreenOcr'
import { type ScreenRect } from './services/selectionBounds'
import {
  startSelectionHook,
  stopSelectionHook,
  setSelectionHookEnabled,
  setTypingHookEnabled,
  setSelectionHookSuspended,
  waitForModifiersReleased,
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
let learnWindow: BrowserWindow | null = null
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
const registeredHotkeys = new Set<string>()
const activeBubbleShortcuts = new Set<string>()
let pendingCaptureImage: NativeImage | null = null
let pendingCaptureScale = 1
let overlayBounds: Rectangle | null = null

const isDev = !!process.env.VITE_DEV_SERVER_URL
const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'

type MacPermission = 'accessibility' | 'screen'

const MAC_PRIVACY_PANES: Record<MacPermission, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

function macPermissionStatus() {
  if (!IS_MAC) return { accessibility: true, screen: true }
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
  }
}

/** macOS 托盘常驻：只有设置窗口可见时才显示 Dock 图标（同时提供 Edit 菜单让 Cmd+C/V 在输入框可用） */
function syncDockVisibility() {
  if (!IS_MAC || !app.dock) return
  const visible = [mainWindow, learnWindow].some((w) => !!w && !w.isDestroyed() && w.isVisible())
  if (visible) void app.dock.show()
  else app.dock.hide()
}

function preloadPath() {
  return path.join(__dirname, 'preload.js')
}

/**
 * 打包后用本机 HTTP 服务（只监听 127.0.0.1）提供界面，而不是 file://：
 * YouTube 内嵌播放器要求页面有 http(s) 来源，file:// 或自定义协议下会报错 152/153，视频一片黑。
 */
let rendererOrigin = ''

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

function startRendererServer(): Promise<void> {
  const root = path.join(__dirname, '../dist')
  const server = http.createServer((req, res) => {
    let rel = '/'
    try {
      rel = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
    } catch {
      /* 非法地址按首页处理 */
    }
    const file = path.join(root, rel === '/' ? 'index.html' : rel)
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end()
      return
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
      res.end(data)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') rendererOrigin = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
}

function rendererUrl(hash = '') {
  if (isDev) return `${process.env.VITE_DEV_SERVER_URL}${hash}`
  if (rendererOrigin) return `${rendererOrigin}/${hash}`
  const file = path.join(__dirname, '../dist/index.html')
  return hash ? `file://${file}${hash}` : `file://${file}`
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 400,
    minHeight: 480,
    show: false,
    // macOS 用系统红绿灯按钮；Windows 无边框自绘标题栏
    frame: IS_MAC,
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } }
      : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7',
    skipTaskbar: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.loadURL(rendererUrl())
  mainWindow.on('show', syncDockVisibility)
  mainWindow.on('hide', syncDockVisibility)
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
  if (IS_MAC) app.focus({ steal: true })
  mainWindow?.focus()
}

/** YouTube 学习窗口：上方播放器，下方 / 右侧随播放滚动的双语字幕 */
function showLearnWindow(initialVideo?: string) {
  if (learnWindow && !learnWindow.isDestroyed()) {
    if (initialVideo) learnWindow.webContents.send('learn:open-video', initialVideo)
    if (learnWindow.isMinimized()) learnWindow.restore()
    learnWindow.show()
    if (IS_MAC) app.focus({ steal: true })
    learnWindow.focus()
    return
  }
  learnWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    show: false,
    frame: IS_MAC,
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } }
      : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7',
    title: 'YouTube 学习',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  learnWindow.loadURL(
    rendererUrl(initialVideo ? `#/learn?v=${encodeURIComponent(initialVideo)}` : '#/learn'),
  )
  learnWindow.once('ready-to-show', () => {
    learnWindow?.show()
    if (IS_MAC) app.focus({ steal: true })
  })
  learnWindow.on('show', syncDockVisibility)
  learnWindow.on('hide', syncDockVisibility)
  learnWindow.on('closed', () => {
    learnWindow = null
    cancelLearnJob()
    syncDockVisibility()
  })
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
    // macOS：非激活面板，点击卡片不会抢走原应用的焦点（替换/粘贴依赖这一点）
    ...(IS_MAC ? { type: 'panel' as const, acceptFirstMouse: true } : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  bubbleWindow.setAlwaysOnTop(true, 'screen-saver')
  if (IS_MAC) {
    bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // 不出现在截屏里：微信输入框截屏识别时不会把译文卡片自己也识别进去
    bubbleWindow.setContentProtection(true)
  }
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

function registerBubbleShortcuts(mode: 'selection' | 'screenshot' | 'typing', manual = false) {
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

  // 自动打字检测时不占用方向键 / 回车（用户还在输入）；快捷键手动触发时可直接回车替换
  if (mode !== 'typing' || manual) {
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
  // macOS / Linux 的 hook 与 AX 坐标本就是逻辑坐标
  if (!IS_WIN) return point
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
  if (!IS_WIN) return false
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
  manual?: boolean
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
    registerBubbleShortcuts(mode, !!payload.manual)
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
  manual = false,
) {
  const approxWidth = Math.min(BUBBLE_MAX_WIDTH, Math.max(168, translation.length * 15 + 124))
  const approxHeight = Math.min(
    BUBBLE_MAX_HEIGHT,
    Math.max(64, Math.ceil(translation.length / 28) * 23 + 42),
  )
  placeBelowDipRect(anchor, approxWidth, approxHeight)
  await showInlineResult({ source, translation, mode, manual })
}

function isPointOverOurWindows(point: { x: number; y: number }) {
  for (const win of [bubbleWindow, mainWindow, learnWindow]) {
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
  const t0 = Date.now()
  diag('select', { step: 'drag', w: Math.round(rawRect.width), h: Math.round(rawRect.height) })
  if (screenshotActive || Date.now() < ignoreSelectionUntil) return diag('select', { skip: 'screenshot-or-cooldown' })
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) return diag('select', { skip: 'overlay' })
  const settings = getSettings()
  if (!settings.autoSelectTranslate) return diag('select', { skip: 'disabled' })
  const cursor = rawRect.cursorDip ?? screen.getCursorScreenPoint()
  const dipEnd = hookPointToDip({ x: rawRect.endX, y: rawRect.endY }, cursor)
  if (isPointOverOurWindows(cursor) || isPointOverOurWindows(dipEnd)) {
    return diag('select', { skip: 'over-own-window' })
  }
  if (translating) return diag('select', { skip: 'busy-translating' })

  const seq = ++activeTaskSeq
  translating = true
  ignoreOutsideUntil = Date.now() + 600
  const anchor = expandToTextLine(hookRectToDip(rawRect, cursor))
  try {
    const text = await captureSelectedText()
    diag('select', { step: 'captured', len: text.length, ms: Date.now() - t0 })
    if (seq !== activeTaskSeq || screenshotActive) return
    if (!text) return
    if (!/[A-Za-z\u00C0-\u024F]/.test(text)) return diag('select', { skip: 'no-latin-letters' })

    placeBelowDipRect(anchor, 88, 36)
    await showInlineResult({ source: text, translation: '…', loading: true, mode: 'selection' })
    const translation = await translate(text, 'en-zh')
    if (seq !== activeTaskSeq || screenshotActive) return
    await showTranslationResult(anchor, text, translation, 'selection')
    diag('select', { step: 'shown', ms: Date.now() - t0 })
  } catch (err) {
    if (seq !== activeTaskSeq || screenshotActive) return
    const msg = err instanceof Error ? err.message : String(err)
    diag('select', { step: 'error', msg: msg.slice(0, 200) })
    placeBelowDipRect(anchor, 240, 36)
    await showInlineResult({ source: '', translation: msg, error: true, mode: 'selection' })
  } finally {
    if (seq === activeTaskSeq) {
      translating = false
    }
  }
}

async function onGlobalTypingPause(hint: { maybeComposing: boolean } = { maybeComposing: false }) {
  if (screenshotActive || Date.now() < ignoreSelectionUntil) return
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) return
  const settings = getSettings()
  if (settings.autoTypeTranslate === false) return
  if (translating) return diag('type', { skip: 'busy-translating' })

  const t0 = Date.now()
  const info = await readFocusedInput(process.pid, hint)
  diag('type', { step: 'read', len: info?.text.length ?? -1, hasChinese: !!info && /[\u4e00-\u9fff]/.test(info.text), ms: Date.now() - t0 })
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
    // macOS：允许窗口覆盖菜单栏区域
    enableLargerThanScreen: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  if (IS_MAC) overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
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
  if (IS_MAC && !macPermissionStatus().screen) {
    // 未授权时 desktopCapturer 只会返回壁纸；触发一次系统登记后引导用户去授权
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => [])
    void shell.openExternal(MAC_PRIVACY_PANES.screen)
    throw new Error('请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许本应用，然后重启应用')
  }
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
      if (IS_MAC) {
        overlay.setBounds(shot.bounds)
        app.focus({ steal: true })
      }
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

/**
 * 快捷键手动翻译当前输入框：先走无障碍接口，读不到（如微信）再用「全选 → 复制」读取。
 * 含中文 → 译成英文（可替换回输入框）；否则英译汉。
 */
async function translateFocusedInput() {
  if (screenshotActive) return
  const ours = BrowserWindow.getFocusedWindow()
  if (ours && ours === mainWindow) return

  const seq = ++activeTaskSeq
  translating = true
  setSelectionHookSuspended(true)
  ignoreSelectionUntil = Date.now() + 1500
  ignoreOutsideUntil = Date.now() + 1500
  let anchor: ScreenRect | null = null
  try {
    hideInlineTranslation()
    await waitForModifiersReleased()
    if (seq !== activeTaskSeq) return
    const info = await readFocusedInput(process.pid, { allowClipboard: true })
    if (seq !== activeTaskSeq) return
    const text = info?.text.trim() || ''
    if (!info || !text) {
      const cursor = screen.getCursorScreenPoint()
      placeBelowDipRect({ x: cursor.x, y: cursor.y, width: 1, height: 1 }, 220, 36)
      await showInlineResult({ source: '', translation: '没有读到输入框内容', error: true, mode: 'typing' })
      return
    }
    anchor = expandToTextLine(info.rect)
    const toEnglish = /[\u4e00-\u9fff]/.test(text)
    const mode = toEnglish ? 'typing' : 'selection'
    lastTypedSourceText = text
    placeBelowDipRect(anchor, 116, 60)
    await showInlineResult({ source: text, translation: '…', loading: true, mode })
    const translation = await translate(text, toEnglish ? 'zh-en' : 'en-zh')
    if (seq !== activeTaskSeq) return
    await showTranslationResult(anchor, text, translation, mode, true)
  } catch (err) {
    if (seq !== activeTaskSeq) return
    const msg = err instanceof Error ? err.message : String(err)
    const cursor = screen.getCursorScreenPoint()
    placeBelowDipRect(anchor ?? { x: cursor.x, y: cursor.y, width: 1, height: 1 }, 240, 60)
    await showInlineResult({ source: '', translation: msg, error: true, mode: 'typing' })
  } finally {
    if (seq === activeTaskSeq) translating = false
    setSelectionHookSuspended(false)
  }
}

function registerHotkeys() {
  for (const accel of registeredHotkeys) {
    try {
      globalShortcut.unregister(accel)
    } catch {
      /* ignore */
    }
  }
  registeredHotkeys.clear()
  const settings = getSettings()
  const bindings: [string | undefined, () => void][] = [
    [settings.screenshotHotkey, () => void startScreenshotTranslate()],
    [settings.inputTranslateHotkey, () => void translateFocusedInput()],
  ]
  for (const [raw, fn] of bindings) {
    const accel = raw?.trim()
    if (!accel || registeredHotkeys.has(accel)) continue
    try {
      if (globalShortcut.register(accel, fn)) registeredHotkeys.add(accel)
      else console.error('hotkey already in use', accel)
    } catch (err) {
      console.error('hotkey failed', accel, err)
    }
  }
}

function createTray() {
  // macOS：*Template.png 会被当作模板图标，自动适配菜单栏浅色 / 深色，并自动加载 @2x
  const iconPath = path.join(__dirname, IS_MAC ? '../assets/trayTemplate.png' : '../assets/tray.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (IS_MAC && !icon.isEmpty()) icon.setTemplateImage(true)
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAASElEQVRYR+3XMQEAIAwDsHF/z0GAxMcdpJ1dTQJ4M5kAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/G3Q8gN9DwABHgABvA8BvA8B8AFYDwHwvQfYNwAAAABJRU5ErkJggg==',
    )
  }
  if (!IS_MAC && !icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 })
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip(IS_MAC ? 'English Tools' : 'English Tools · 右键打开设置')

  rebuildTray = () => {
    const s = getSettings()
    const menu = Menu.buildFromTemplate([
      {
        label: 'YouTube 学习',
        click: () => showLearnWindow(),
      },
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
    if (partial.screenshotHotkey !== undefined || partial.inputTranslateHotkey !== undefined) {
      registerHotkeys()
    }
    rebuildTray()
    return next
  })

  ipcMain.handle('permissions:status', () => macPermissionStatus())
  // 屏幕录制等权限要重启后才生效
  ipcMain.handle('app:relaunch', () => {
    quitting = true
    app.relaunch()
    app.exit(0)
  })

  // 开机自启：由系统登录项管理（macOS 登录项 / Windows 启动项），不存配置文件。
  // 开发模式下会把裸 Electron 注册成启动项，所以只在打包后的正式版开放。
  const autostartState = () => ({
    supported: app.isPackaged,
    enabled: app.isPackaged && app.getLoginItemSettings().openAtLogin,
  })
  ipcMain.handle('autostart:get', () => autostartState())
  ipcMain.handle('autostart:set', (_e, enabled: boolean) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
    return autostartState()
  })
  ipcMain.handle('permissions:open', (_e, kind: MacPermission) => {
    if (!IS_MAC || !MAC_PRIVACY_PANES[kind]) return
    if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
    void shell.openExternal(MAC_PRIVACY_PANES[kind])
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
      // 用 ⌥2 / Alt+2 触发时 ⌥ 往往还按着：此时发出的 ⌘A ⌘V 会变成 ⌥⌘A ⌥⌘V（Windows 上是 Ctrl+Alt+A，
      // 还会触发 QQ 截图），输入框不会被替换。先等修饰键松开
      await waitForModifiersReleased()
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

  // 窗口按钮作用于发出请求的那个窗口（设置窗口 / 学习窗口）
  const senderWindow = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle('window:minimize', (e) => senderWindow(e)?.minimize())
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = senderWindow(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  // 自己实现的标题栏拖动：记下按下时的窗口位置，之后按鼠标位移设置新位置
  const dragOrigin = new Map<number, [number, number]>()
  ipcMain.on('window:drag-start', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isMaximized() || win.isFullScreen()) return
    dragOrigin.set(e.sender.id, win.getPosition() as [number, number])
  })
  ipcMain.on('window:drag-move', (e, dx: number, dy: number) => {
    const origin = dragOrigin.get(e.sender.id)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!origin || !win) return
    win.setPosition(Math.round(origin[0] + dx), Math.round(origin[1] + dy))
  })
  ipcMain.handle('window:hide', () => mainWindow?.hide())
  ipcMain.handle('window:close', (e) => {
    const win = senderWindow(e)
    // 设置窗口关闭即隐藏到托盘；学习窗口直接关闭
    if (!win || win === mainWindow) mainWindow?.hide()
    else win.close()
  })

  ipcMain.handle('learn:open', () => showLearnWindow())
  ipcMain.handle('learn:load', (e, input: string) => {
    const wc = e.sender
    const send = (channel: string, payload: unknown) => {
      if (!wc.isDestroyed()) wc.send(channel, payload)
    }
    return loadLearnVideo(input, {
      status: (st) => send('learn:status', st),
      translated: (videoId, items) => send('learn:translated', { videoId, items }),
    })
  })
  ipcMain.handle('learn:recent', () => getRecentVideos())
  ipcMain.handle('learn:recent:remove', (_e, videoId: string) => removeRecentVideo(videoId))
  ipcMain.handle('learn:favorites', () => getFavoriteCues())
  ipcMain.handle('learn:favorite:toggle', (_e, item: Omit<FavoriteCue, 'savedAt'>) =>
    toggleFavoriteCue(item),
  )
  ipcMain.handle('vocab:list', () => getVocabulary())
  ipcMain.handle('vocab:toggle', (_e, item: Omit<VocabItem, 'id' | 'createdAt'>) => toggleVocabulary(item))
  ipcMain.handle('vocab:update', (_e, word: string, patch: Partial<Pick<VocabItem, 'meaning' | 'detail'>>) =>
    updateVocabulary(word, patch),
  )
  ipcMain.handle('vocab:remove', (_e, id: string) => removeVocabulary(id))
  ipcMain.handle('learn:prefs', () => getLearnPrefs())
  ipcMain.handle('learn:prefs:set', (_e, partial: Partial<LearnPrefs>) => setLearnPrefs(partial))
  ipcMain.handle('learn:lookup', (_e, word: string, context?: string) => lookupWord(word, context))
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

function startGlobalHook() {
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
      (hint) => {
        void onGlobalTypingPause(hint)
      },
    )
  } catch (err) {
    console.error('selection hook failed', err)
  }
}

/** macOS 需要「辅助功能」权限才能监听全局鼠标键盘；未授权时弹出系统提示并等待授权后再启动 */
function startGlobalHookWhenPermitted() {
  if (!IS_MAC || systemPreferences.isTrustedAccessibilityClient(false)) {
    startGlobalHook()
    return
  }
  systemPreferences.isTrustedAccessibilityClient(true)
  showMainWindow()
  const timer = setInterval(() => {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) return
    clearInterval(timer)
    startGlobalHook()
  }, 2000)
}

// 正式版只允许一个实例：重复启动时唤起已有实例的设置窗口
// （开发模式下 vite 热重启会短暂同时存在新旧两个进程，不加锁）
const gotInstanceLock = isDev || app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
}

// 任何来源的退出（⌘Q、关机 / 注销、开发服务器重启时的 SIGTERM）都放行，
// 否则主窗口的「关闭即隐藏」会拦住退出，留下孤儿进程
app.on('before-quit', () => {
  quitting = true
})

/**
 * YouTube 内嵌播放器要求请求带 Referer（否则报错 153）。
 * 打包后页面是 file:// 没有 Referer，这里给 YouTube 相关请求补上。
 */
function patchYouTubeReferer() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'] },
    (details, callback) => {
      const headers = details.requestHeaders
      if (!headers.Referer || headers.Referer.startsWith('file:')) {
        headers.Referer = 'https://www.youtube.com/'
      }
      callback({ requestHeaders: headers })
    },
  )
}

app.whenReady().then(async () => {
  if (!gotInstanceLock) return
  patchYouTubeReferer()
  if (!isDev) {
    await startRendererServer().catch((err) => console.error('[renderer] 本地服务启动失败，退回 file://', err))
  }
  createMainWindow()
  createBubbleWindow()
  createTray()
  registerIpc()

  const settings = getSettings()
  setSelectionHookEnabled(settings.autoSelectTranslate)
  setTypingHookEnabled(settings.autoTypeTranslate !== false)
  registerHotkeys()
  if (!settings.apiKey?.trim()) showMainWindow()
  syncDockVisibility()
  startGlobalHookWhenPermitted()
  // 开发调试：ENGLISHTOOLS_OPEN_LEARN=<视频链接或 ID> 启动后直接打开学习窗口
  if (process.env.ENGLISHTOOLS_OPEN_LEARN) showLearnWindow(process.env.ENGLISHTOOLS_OPEN_LEARN)
  // 预热系统文字识别模型（首次加载中文模型要十几秒），供微信输入框截屏识别使用
  if (IS_MAC && macScreenOcrAvailable()) {
    setTimeout(() => void warmUpMacOcr(), 3000)
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
