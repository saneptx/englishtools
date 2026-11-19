import { app } from 'electron'
import path from 'node:path'
import ElectronStore from 'electron-store'

/**
 * 固定数据目录为 <appData>/englishtools。
 * 否则目录名跟随 package.json 的 productName（English Tools），
 * 开发版与安装版、改名前后会各用一套设置（API Key、字幕缓存等）。
 * 必须在创建 Store 之前执行；本模块是 main.ts 最先导入的业务模块。
 */
app.setPath('userData', path.join(app.getPath('appData'), 'englishtools'))

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
  /** 简短释义（AI 标注的词义，或查词结果的第一行） */
  meaning: string
  /** 完整查词结果 */
  detail?: string
  /** 出现的原句及译文 */
  context?: string
  contextZh?: string
  /** 来源视频，用于跳回原句 */
  videoId?: string
  title?: string
  startMs?: number
  createdAt: number
}

export interface LearnPrefs {
  /** 播放速度 */
  rate: number
}

export interface RecentVideo {
  videoId: string
  title: string
  author: string
  openedAt: number
}

export interface FavoriteCue {
  key: string
  videoId: string
  title: string
  startMs: number
  en: string
  zh: string
  savedAt: number
}

export interface StoreSchema {
  settings: AppSettings
  vocabulary: VocabItem[]
  subtitleCache: Record<string, unknown>
  recentVideos: RecentVideo[]
  favoriteCues: FavoriteCue[]
  learnPrefs: LearnPrefs
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
    recentVideos: [],
    favoriteCues: [],
    learnPrefs: { rate: 1 },
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

export function removeVocabulary(id: string): VocabItem[] {
  const next = getVocabulary().filter((v) => v.id !== id)
  store.set('vocabulary', next)
  return next
}

/** 收藏 / 取消收藏生词（按单词去重，不区分大小写），返回最新列表 */
export function toggleVocabulary(item: Omit<VocabItem, 'id' | 'createdAt'>): VocabItem[] {
  const list = getVocabulary()
  const existing = list.find((v) => v.word.toLowerCase() === item.word.toLowerCase())
  if (existing) return removeVocabulary(existing.id)
  addVocabulary(item)
  return getVocabulary()
}

/** 补全已收藏生词的释义（收藏时查词结果还没返回的情况） */
export function updateVocabulary(word: string, patch: Partial<Pick<VocabItem, 'meaning' | 'detail'>>): VocabItem[] {
  const list = getVocabulary().map((v) =>
    v.word.toLowerCase() === word.toLowerCase()
      ? { ...v, meaning: v.meaning || patch.meaning || '', detail: v.detail || patch.detail }
      : v,
  )
  store.set('vocabulary', list)
  return list
}

export function getLearnPrefs(): LearnPrefs {
  return { rate: 1, ...(store.get('learnPrefs') as Partial<LearnPrefs> | undefined) }
}

export function setLearnPrefs(partial: Partial<LearnPrefs>): LearnPrefs {
  const next = { ...getLearnPrefs(), ...partial }
  store.set('learnPrefs', next)
  return next
}

export function getSubtitleCache(videoId: string): unknown | null {
  const cache = store.get('subtitleCache') ?? {}
  return cache[videoId] ?? null
}

export function setSubtitleCache(videoId: string, data: unknown): void {
  const cache = store.get('subtitleCache') ?? {}
  store.set('subtitleCache', { ...cache, [videoId]: data })
}

/** 删除最近列表之外的字幕缓存，避免配置文件无限增长 */
export function pruneSubtitleCache(keepKeys: string[]): void {
  const cache = store.get('subtitleCache') ?? {}
  const keep = new Set(keepKeys)
  const next: Record<string, unknown> = {}
  for (const k of Object.keys(cache)) if (keep.has(k)) next[k] = cache[k]
  store.set('subtitleCache', next)
}

const MAX_RECENT = 20

export function getRecentVideos(): RecentVideo[] {
  return store.get('recentVideos') ?? []
}

export function touchRecentVideo(v: Omit<RecentVideo, 'openedAt'>): RecentVideo[] {
  const list = [{ ...v, openedAt: Date.now() }, ...getRecentVideos().filter((x) => x.videoId !== v.videoId)].slice(
    0,
    MAX_RECENT,
  )
  store.set('recentVideos', list)
  return list
}

export function removeRecentVideo(videoId: string): RecentVideo[] {
  const list = getRecentVideos().filter((x) => x.videoId !== videoId)
  store.set('recentVideos', list)
  return list
}

export function getFavoriteCues(): FavoriteCue[] {
  return store.get('favoriteCues') ?? []
}

/** 收藏 / 取消收藏一句字幕，返回操作后是否为已收藏 */
export function toggleFavoriteCue(item: Omit<FavoriteCue, 'savedAt'>): boolean {
  const list = getFavoriteCues()
  if (list.some((f) => f.key === item.key)) {
    store.set(
      'favoriteCues',
      list.filter((f) => f.key !== item.key),
    )
    return false
  }
  store.set('favoriteCues', [{ ...item, savedAt: Date.now() }, ...list])
  return true
}
