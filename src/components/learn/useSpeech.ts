import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 朗读英文：优先用主进程的 Edge 神经语音（音质好），失败时退回系统自带语音合成。
 */
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const seqRef = useRef(0)

  const stop = useCallback(() => {
    seqRef.current++
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current = null
    }
    window.speechSynthesis?.cancel()
    setSpeaking(false)
  }, [])

  const systemSpeak = useCallback((text: string) => {
    if (!('speechSynthesis' in window)) {
      setSpeaking(false)
      return
    }
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    u.rate = 0.9
    const voice = window.speechSynthesis.getVoices().find((v) => /^en[-_]US/i.test(v.lang))
    if (voice) u.voice = voice
    u.onend = () => setSpeaking(false)
    u.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(u)
  }, [])

  const speak = useCallback(
    async (text: string) => {
      const clean = text.trim()
      if (!clean) return
      stop()
      const seq = ++seqRef.current
      setSpeaking(true)
      try {
        const url = await window.englishTools.speakText(clean)
        if (seq !== seqRef.current) return
        if (!url) return systemSpeak(clean)
        const audio = new Audio(url)
        audioRef.current = audio
        audio.onended = () => {
          if (audioRef.current === audio) audioRef.current = null
          setSpeaking(false)
        }
        audio.onerror = () => {
          if (seq === seqRef.current) systemSpeak(clean)
        }
        await audio.play()
      } catch {
        if (seq === seqRef.current) systemSpeak(clean)
      }
    },
    [stop, systemSpeak],
  )

  useEffect(() => stop, [stop])

  return { speak, stop, speaking }
}
