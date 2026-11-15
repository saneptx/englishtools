import https from 'node:https'
import crypto from 'node:crypto'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM_FULL_VERSION = '130.0.2849.68'
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`
const DEFAULT_VOICE = 'en-US-JennyNeural'

const audioCache = new Map<string, string>()
const MAX_CACHE_ENTRIES = 30

/** 与微软服务器时间的偏移量（毫秒），防止本机系统时间不准导致 Sec-MS-GEC 校验 403 */
let serverClockOffsetMs = 0

function nowSyncedMs(): number {
  return Date.now() + serverClockOffsetMs
}

function generateSecMsGec(timestampMs = nowSyncedMs()): string {
  const winEpoch = 11644473600
  const ticks = Math.floor(timestampMs / 1000) + winEpoch
  const rounded = ticks - (ticks % 300)
  const strToHash = `${rounded}0000000${TRUSTED_CLIENT_TOKEN}`
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase()
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 清理 OCR 或跨行划词产生的硬换行和连字符断词 */
function cleanTextForSpeech(raw: string): string {
  return raw
    .replace(/([A-Za-z])-\r?\n\s*([A-Za-z])/g, '$1$2')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  const mask = crypto.randomBytes(4)
  let header: Buffer

  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x81
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }

  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i] ^ mask[i & 3]
  }
  return Buffer.concat([header, mask, masked])
}

function requestEdgeTtsOnce(text: string, voice: string): Promise<{ dataUrl?: string; retryWithClockSync?: boolean }> {
  const connId = crypto.randomUUID().replace(/-/g, '')
  const reqId = crypto.randomUUID().replace(/-/g, '')
  const secMsGec = generateSecMsGec()
  const muid = crypto.randomBytes(16).toString('hex').toUpperCase()
  const wsKey = crypto.randomBytes(16).toString('base64')

  const path =
    `/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connId}`

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err?: Error, result?: { dataUrl?: string; retryWithClockSync?: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(result || {})
    }

    const timer = setTimeout(() => {
      req.destroy()
      finish(new Error('Edge 语音合成超时'))
    }, 10000)

    const req = https.request({
      host: 'speech.platform.bing.com',
      port: 443,
      path,
      method: 'GET',
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${muid};`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': wsKey,
      },
    })

    req.on('error', (err) => finish(err))

    req.on('response', (res) => {
      const dateHeader = res.headers?.date
      if (dateHeader) {
        const serverMs = Date.parse(dateHeader)
        if (Number.isFinite(serverMs)) {
          serverClockOffsetMs = serverMs - Date.now()
          res.resume()
          finish(undefined, { retryWithClockSync: true })
          return
        }
      }
      res.resume()
      finish(new Error(`Edge TTS 握手失败 (${res.statusCode})`))
    })

    req.on('upgrade', (res, socket, head) => {
      const dateHeader = res.headers?.date
      if (dateHeader) {
        const serverMs = Date.parse(dateHeader)
        if (Number.isFinite(serverMs)) {
          serverClockOffsetMs = serverMs - Date.now()
        }
      }

      const audioChunks: Buffer[] = []
      let recvBuf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
      let fragOpcode = 0
      let fragParts: Buffer[] = []

      const handleMessage = (opcode: number, data: Buffer) => {
        if (opcode === 2) {
          if (data.length < 2) return
          const headerLen = data.readUInt16BE(0)
          if (data.length < 2 + headerLen) return
          const headerStr = data.subarray(2, 2 + headerLen).toString('utf8')
          if (headerStr.includes('Path:audio')) {
            const body = data.subarray(2 + headerLen)
            if (body.length > 0) audioChunks.push(Buffer.from(body))
          }
        } else if (opcode === 1) {
          const str = data.toString('utf8')
          if (str.includes('Path:turn.end')) {
            socket.end()
            if (audioChunks.length === 0) {
              finish(new Error('未收到语音数据'))
              return
            }
            const mp3 = Buffer.concat(audioChunks)
            finish(undefined, { dataUrl: `data:audio/mpeg;base64,${mp3.toString('base64')}` })
          }
        } else if (opcode === 8) {
          socket.end()
          if (audioChunks.length > 0) {
            const mp3 = Buffer.concat(audioChunks)
            finish(undefined, { dataUrl: `data:audio/mpeg;base64,${mp3.toString('base64')}` })
          } else {
            finish(new Error('Edge TTS 连接已关闭'))
          }
        }
      }

      const processBuffer = () => {
        while (recvBuf.length >= 2) {
          const b0 = recvBuf[0]
          const b1 = recvBuf[1]
          const fin = (b0 & 0x80) !== 0
          const opcode = b0 & 0x0f
          const masked = (b1 & 0x80) !== 0
          let payloadLen = b1 & 0x7f
          let offset = 2

          if (payloadLen === 126) {
            if (recvBuf.length < 4) return
            payloadLen = recvBuf.readUInt16BE(2)
            offset = 4
          } else if (payloadLen === 127) {
            if (recvBuf.length < 10) return
            payloadLen = Number(recvBuf.readBigUInt64BE(2))
            offset = 10
          }

          let maskKey: Buffer | null = null
          if (masked) {
            if (recvBuf.length < offset + 4) return
            maskKey = recvBuf.subarray(offset, offset + 4)
            offset += 4
          }

          if (recvBuf.length < offset + payloadLen) return

          const frameData = Buffer.from(recvBuf.subarray(offset, offset + payloadLen))
          recvBuf = recvBuf.subarray(offset + payloadLen)

          if (maskKey) {
            for (let i = 0; i < frameData.length; i++) {
              frameData[i] ^= maskKey[i & 3]
            }
          }

          if (opcode === 9) {
            const pong = Buffer.alloc(2)
            pong[0] = 0x8a
            pong[1] = 0x80
            socket.write(Buffer.concat([pong, crypto.randomBytes(4)]))
            continue
          }

          if (opcode === 0) {
            fragParts.push(frameData)
            if (fin) {
              const full = Buffer.concat(fragParts)
              const op = fragOpcode
              fragParts = []
              fragOpcode = 0
              handleMessage(op, full)
            }
          } else if (!fin && (opcode === 1 || opcode === 2)) {
            fragOpcode = opcode
            fragParts = [frameData]
          } else {
            handleMessage(opcode, frameData)
          }
        }
      }

      socket.on('data', (chunk: Buffer) => {
        recvBuf = Buffer.concat([recvBuf, chunk])
        processBuffer()
      })

      socket.on('error', (err) => finish(err))
      socket.on('close', () => {
        if (!settled) {
          if (audioChunks.length > 0) {
            const mp3 = Buffer.concat(audioChunks)
            finish(undefined, { dataUrl: `data:audio/mpeg;base64,${mp3.toString('base64')}` })
          } else {
            finish(new Error('Edge TTS 连接意外断开'))
          }
        }
      })

      const isoNow = new Date(nowSyncedMs()).toISOString()

      // 1. 发送 speech.config
      const configMsg =
        `X-Timestamp:${isoNow}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'false',
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        })
      socket.write(encodeWsTextFrame(configMsg))

      // 2. 发送 SSML
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/xml/synthesis' xml:lang='en-US'>` +
        `<voice name='${voice}'>` +
        `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody>` +
        `</voice></speak>`
      const ssmlMsg =
        `X-RequestId:${reqId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${isoNow}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml
      socket.write(encodeWsTextFrame(ssmlMsg))

      if (recvBuf.length > 0) processBuffer()
    })

    req.end()
  })
}

/**
 * 使用微软 Edge Neural TTS (en-US-JennyNeural) 合成高自然度美式英语语音，返回 base64 DataURL；
 * 若失败则返回 null，不向控制台抛出未捕获 IPC 异常。
 */
export async function synthesizeEdgeTts(rawText: string, voice = DEFAULT_VOICE): Promise<string | null> {
  const text = cleanTextForSpeech(rawText)
  if (!text) return null

  const cacheKey = `${voice}:${text}`
  const cached = audioCache.get(cacheKey)
  if (cached) return cached

  try {
    let res = await requestEdgeTtsOnce(text, voice)
    if (res.retryWithClockSync) {
      res = await requestEdgeTtsOnce(text, voice)
    }
    const dataUrl = res.dataUrl
    if (!dataUrl) return null

    if (audioCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = audioCache.keys().next().value
      if (oldestKey) audioCache.delete(oldestKey)
    }
    audioCache.set(cacheKey, dataUrl)
    return dataUrl
  } catch {
    return null
  }
}
