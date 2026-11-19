import { useCallback, useEffect, useRef, useState } from 'react'

/** YouTube IFrame Player API 的最小类型 */
interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getPlayerState(): number
  setPlaybackRate(rate: number): void
  getPlaybackRate(): number
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
        onPlaybackRateChange?: (e: { data: number }) => void
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
export function useYouTubePlayer(videoId: string | null, initialRate = 1) {
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const loadedIdRef = useRef<string | null>(null)
  const rateRef = useRef(initialRate)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [timeMs, setTimeMs] = useState(0)
  const [rate, setRateState] = useState(initialRate)
  const [error, setError] = useState<string | null>(null)

  /** 新视频加载后 YouTube 会把速度重置为 1，播放开始时补设一次 */
  const applyRate = useCallback(() => {
    const p = playerRef.current
    if (!p?.getPlaybackRate) return
    try {
      if (p.getPlaybackRate() !== rateRef.current) p.setPlaybackRate(rateRef.current)
    } catch {
      /* 播放器尚未就绪 */
    }
  }, [])

  const destroyPlayer = useCallback(() => {
    try {
      playerRef.current?.destroy()
    } catch {
      /* ignore */
    }
    playerRef.current = null
    loadedIdRef.current = null
    setReady(false)
    setPlaying(false)
    setTimeMs(0)
  }, [])

  useEffect(() => {
    // 返回首页时播放器所在的 DOM 已被移除，旧播放器必须销毁，否则下一个视频会加载进一个不在页面上的播放器
    if (!videoId) {
      destroyPlayer()
      return
    }
    let cancelled = false
    setError(null)
    if (playerRef.current && hostRef.current?.isConnected && hostRef.current.firstChild) {
      if (loadedIdRef.current !== videoId) {
        loadedIdRef.current = videoId
        playerRef.current.loadVideoById(videoId)
        setTimeMs(0)
      }
      return
    }
    if (playerRef.current) destroyPlayer()
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
            onReady: () => {
              setReady(true)
              applyRate()
            },
            onStateChange: (e) => {
              setPlaying(e.data === 1)
              if (e.data === 1) {
                applyRate()
                // cc_load_policy=0 挡不住用户在 YouTube 账号里设置的「始终显示字幕」，开始播放时再关一次
                try {
                  playerRef.current?.unloadModule?.('captions')
                } catch {
                  /* ignore */
                }
              }
            },
            // 用户在播放器自带菜单里改速度时同步回来
            onPlaybackRateChange: (e) => {
              rateRef.current = e.data
              setRateState(e.data)
            },
            onError: (e) => setError(PLAYER_ERRORS[e.data] || `播放器错误 (${e.data})`),
          },
        })
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [videoId, destroyPlayer, applyRate])

  // 卸载时销毁播放器
  useEffect(() => destroyPlayer, [destroyPlayer])

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
  const setRate = useCallback(
    (r: number) => {
      rateRef.current = r
      setRateState(r)
      applyRate()
    },
    [applyRate],
  )

  return { hostRef, ready, playing, timeMs, rate, error, seekTo, togglePlay, pause, setRate }
}
