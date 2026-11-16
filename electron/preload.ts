import { contextBridge, ipcRenderer } from 'electron'
import type { LearnVideo, LearnStatus } from './services/learn'
import type { RecentVideo, FavoriteCue } from './services/store'
import type { SubtitleCue } from './services/youtube'

export type { LearnVideo, LearnStatus, RecentVideo, FavoriteCue, SubtitleCue }
export type TranslatedItems = {
  videoId: string
  items: { id: string; zh: string; keywords: SubtitleCue['keywords'] }[]
}

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export type TranslateDirection = 'zh-en' | 'en-zh'
export type BubbleShortcutAction = 'prev' | 'next' | 'confirm' | 'speak' | 'replace' | 'copy'

export interface AppSettings {
  apiKey: string
  baseUrl: string
  model: string
  selectHotkey: string
  screenshotHotkey: string
  bilingual: boolean
  autoSelectTranslate: boolean
  autoTypeTranslate: boolean
  inputTranslateHotkey: string
}

const api = {
  platform: process.platform,
  // ── YouTube 学习 ──
  openLearn: () => ipcRenderer.invoke('learn:open'),
  learnLoad: (input: string): Promise<LearnVideo> => ipcRenderer.invoke('learn:load', input),
  learnRecent: (): Promise<RecentVideo[]> => ipcRenderer.invoke('learn:recent'),
  learnRemoveRecent: (videoId: string): Promise<RecentVideo[]> =>
    ipcRenderer.invoke('learn:recent:remove', videoId),
  learnFavorites: (): Promise<FavoriteCue[]> => ipcRenderer.invoke('learn:favorites'),
  learnToggleFavorite: (item: Omit<FavoriteCue, 'savedAt'>): Promise<boolean> =>
    ipcRenderer.invoke('learn:favorite:toggle', item),
  learnLookup: (word: string, context?: string): Promise<string> =>
    ipcRenderer.invoke('learn:lookup', word, context),
  onLearnOpenVideo: (cb: (input: string) => void) => listen<string>('learn:open-video', cb),
  onLearnStatus: (cb: (s: LearnStatus) => void) => listen<LearnStatus>('learn:status', cb),
  onLearnTranslated: (cb: (p: TranslatedItems) => void) => listen<TranslatedItems>('learn:translated', cb),
  getAutostart: (): Promise<{ supported: boolean; enabled: boolean }> => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enabled: boolean): Promise<{ supported: boolean; enabled: boolean }> =>
    ipcRenderer.invoke('autostart:set', enabled),
  getPermissions: (): Promise<{ accessibility: boolean; screen: boolean }> =>
    ipcRenderer.invoke('permissions:status'),
  openPermissionSettings: (kind: 'accessibility' | 'screen') =>
    ipcRenderer.invoke('permissions:open', kind),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (partial: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', partial),
  translate: (text: string, direction: TranslateDirection): Promise<string> =>
    ipcRenderer.invoke('translate', text, direction),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  // 标题栏拖动：用 send 而不是 invoke，移动时每帧一条，不等返回
  windowDragStart: () => ipcRenderer.send('window:drag-start'),
  windowDragMove: (dx: number, dy: number) => ipcRenderer.send('window:drag-move', dx, dy),
  hide: () => ipcRenderer.invoke('window:hide'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  openExternal: (url: string) => ipcRenderer.invoke('window:open-external', url),
  hideBubble: () => ipcRenderer.invoke('bubble:hide'),
  resizeBubble: (size: number | { width?: number; height?: number }) =>
    ipcRenderer.invoke('bubble:resize', size),
  setBubbleIgnoreMouse: (ignore: boolean) => ipcRenderer.invoke('bubble:ignore-mouse', ignore),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  replaceInputText: (text: string): Promise<boolean> => ipcRenderer.invoke('input:replace', text),
  speakText: (text: string): Promise<string | null> => ipcRenderer.invoke('tts:speak', text),
  overlayCancel: () => ipcRenderer.invoke('overlay:cancel'),
  overlayCapture: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('overlay:capture', rect),
  onOverlayStart: (
    cb: (payload: { backgroundDataUrl: string }) => void,
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { backgroundDataUrl: string }) =>
      cb(payload)
    ipcRenderer.on('overlay-start', listener)
    return () => {
      ipcRenderer.removeListener('overlay-start', listener)
    }
  },
  onBubbleUpdate: (
    cb: (payload: {
      source: string
      translation: string
      loading?: boolean
      error?: boolean
      mode?: 'selection' | 'screenshot' | 'typing'
    }) => void,
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        source: string
        translation: string
        loading?: boolean
        error?: boolean
        mode?: 'selection' | 'screenshot' | 'typing'
      },
    ) => cb(payload)
    ipcRenderer.on('bubble-update', listener)
    return () => {
      ipcRenderer.removeListener('bubble-update', listener)
    }
  },
  onBubbleHide: (cb: () => void): (() => void) => {
    const listener = () => cb()
    ipcRenderer.on('bubble-hide', listener)
    return () => {
      ipcRenderer.removeListener('bubble-hide', listener)
    }
  },
  onBubbleAction: (cb: (action: BubbleShortcutAction) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, action: BubbleShortcutAction) => cb(action)
    ipcRenderer.on('bubble-action', listener)
    return () => {
      ipcRenderer.removeListener('bubble-action', listener)
    }
  },
}

contextBridge.exposeInMainWorld('englishTools', api)

export type EnglishToolsApi = typeof api
