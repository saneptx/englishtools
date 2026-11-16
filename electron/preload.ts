import { contextBridge, ipcRenderer } from 'electron'

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
