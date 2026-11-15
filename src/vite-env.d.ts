/// <reference types="vite/client" />

import type { EnglishToolsApi } from '../electron/preload'

declare global {
  interface Window {
    englishTools: EnglishToolsApi
  }
}

export {}
