import ElectronStore from 'electron-store'

// CJS interop when bundled as external require()
const Store = ((ElectronStore as unknown as { default?: typeof ElectronStore }).default ??
  ElectronStore) as typeof ElectronStore

export interface AppSettings {
  apiKey: string
  baseUrl: string
  model: string
  selectHotkey: string
  screenshotHotkey: string
  bilingual: boolean
  /** 监测到划词后自动英译汉 */
  autoSelectTranslate: boolean
  /** 输入法打字上屏后自动汉译英 */
  autoTypeTranslate: boolean
  /** 手动翻译当前输入框的快捷键（读不到输入框的应用，如微信，用它） */
  inputTranslateHotkey: string
}

export interface VocabItem {
  id: string
  word: string
  meaning: string
  context?: string
  createdAt: number
}

export interface StoreSchema {
  settings: AppSettings
  vocabulary: VocabItem[]
  subtitleCache: Record<string, unknown>
}

const defaults: AppSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  selectHotkey: 'CommandOrControl+Shift+T',
  // macOS 上 Cmd+Shift+S 是常见的「另存为」，改用 Option+Shift+S
  screenshotHotkey: process.platform === 'darwin' ? 'Alt+Shift+S' : 'CommandOrControl+Shift+S',
  bilingual: true,
  autoSelectTranslate: true,
  autoTypeTranslate: true,
  inputTranslateHotkey: process.platform === 'darwin' ? 'Alt+T' : 'Control+Alt+T',
}

export const store = new Store<StoreSchema>({
  name: 'englishtools-config',
  defaults: {
    settings: defaults,
    vocabulary: [],
    subtitleCache: {},
  },
})

export function getSettings(): AppSettings {
  return { ...defaults, ...store.get('settings') }
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...partial }
  store.set('settings', next)
  return next
}

export function getVocabulary(): VocabItem[] {
  return store.get('vocabulary') ?? []
}

export function addVocabulary(item: Omit<VocabItem, 'id' | 'createdAt'>): VocabItem {
  const list = getVocabulary()
  const existing = list.find((v) => v.word.toLowerCase() === item.word.toLowerCase())
  if (existing) return existing
  const created: VocabItem = {
    ...item,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  }
  store.set('vocabulary', [created, ...list])
  return created
}

export function removeVocabulary(id: string): void {
  store.set(
    'vocabulary',
    getVocabulary().filter((v) => v.id !== id),
  )
}

export function getSubtitleCache(videoId: string): unknown | null {
  const cache = store.get('subtitleCache') ?? {}
  return cache[videoId] ?? null
}

export function setSubtitleCache(videoId: string, data: unknown): void {
  const cache = store.get('subtitleCache') ?? {}
  store.set('subtitleCache', { ...cache, [videoId]: data })
}
