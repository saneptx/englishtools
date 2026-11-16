import { useCallback, useEffect, useRef, useState } from 'react'

/** YouTube IFrame Player API 的最小类型 */
interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getPlayerState(): number
  setPlaybackRate(rate: number): void
  loadVideoById(id: string): void
  unloadModule?(name: string): void
  destroy(): void
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string
      width?: string
      height?: string
      playerVars?: Record<string, string | number>
      events?: {
        onReady?: () => void
        onStateChange?: (e: { data: number }) => void
        onError?: (e: { data: number }) => void
      }
    },
  ) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YTNamespace> | null = null

function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        prev?.()
        resolve(window.YT!)
      }
      const s = document.createElement('script')
      s.src = 'https://www.youtube.com/iframe_api'
      s.onerror = () => {
        apiPromise = null
        reject(new Error('无法加载 YouTube 播放器，请检查网络'))
      }
      document.head.appendChild(s)
    })
  }
  return apiPromise
}

const PLAYER_ERRORS: Record<number, string> = {
  2: '视频地址无效',
  5: '播放器出错，请重试',
  100: '视频不存在或已被删除',
  101: '视频作者不允许在其他网站播放',
  150: '视频作者不允许在其他网站播放',
  153: '播放器配置错误（缺少来源信息）',
}

/** 播放状态：-1 未开始，0 结束，1 播放中，2 暂停，3 缓冲，5 已就绪 */
export function useYouTubePlayer(videoId: string | null) {
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const loadedIdRef = useRef<string | null>(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [timeMs, setTimeMs] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!videoId) return
    let cancelled = false
    setError(null)
    if (playerRef.current && loadedIdRef.current !== videoId) {
      loadedIdRef.current = videoId
      playerRef.current.loadVideoById(videoId)
      setTimeMs(0)
      return
    }
    if (playerRef.current) return
    loadApi()
      .then((YT) => {
        if (cancelled || !hostRef.current) return
        const mount = document.createElement('div')
        hostRef.current.replaceChildren(mount)
        loadedIdRef.current = videoId
        playerRef.current = new YT.Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            // 关掉 YouTube 自带字幕，避免和下方字幕重复
            cc_load_policy: 0,
            iv_load_policy: 3,
            ...(location.protocol.startsWith('http') ? { origin: location.origin } : {}),
          },
          events: {
            onReady: () => setReady(true),
            onStateChange: (e) => {
              setPlaying(e.data === 1)
              // cc_load_policy=0 挡不住用户在 YouTube 账号里设置的「始终显示字幕」，开始播放时再关一次
              if (e.data === 1) {
                try {
                  playerRef.current?.unloadModule?.('captions')
                } catch {
                  /* ignore */
                }
              }
            },
            onError: (e) => setError(PLAYER_ERRORS[e.data] || `播放器错误 (${e.data})`),
          },
        })
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [videoId])

  // 卸载时销毁播放器
  useEffect(
    () => () => {
      playerRef.current?.destroy()
      playerRef.current = null
    },
    [],
  )

  // 播放时 10Hz 读取进度
  useEffect(() => {
    if (!ready) return
    const timer = setInterval(() => {
      const p = playerRef.current
      if (!p?.getCurrentTime) return
      const t = Math.round(p.getCurrentTime() * 1000)
      setTimeMs((prev) => (Math.abs(prev - t) >= 40 ? t : prev))
    }, 100)
    return () => clearInterval(timer)
  }, [ready])

  const seekTo = useCallback((ms: number, play = true) => {
    const p = playerRef.current
    if (!p) return
    p.seekTo(Math.max(0, ms) / 1000, true)
    setTimeMs(ms)
    if (play) p.playVideo()
  }, [])

  const togglePlay = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    if (p.getPlayerState() === 1) p.pauseVideo()
    else p.playVideo()
  }, [])

  const pause = useCallback(() => playerRef.current?.pauseVideo(), [])
  const setRate = useCallback((r: number) => playerRef.current?.setPlaybackRate(r), [])

  return { hostRef, ready, playing, timeMs, error, seekTo, togglePlay, pause, setRate }
}
