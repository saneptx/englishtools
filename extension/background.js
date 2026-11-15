const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  enabled: true,
}

async function getSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS)
  return { ...DEFAULTS, ...data }
}

async function translate(text, direction) {
  const settings = await getSettings()
  if (!settings.apiKey?.trim()) {
    throw new Error('请先在扩展「选项」中填写 DeepSeek API Key')
  }

  const system =
    direction === 'zh-en'
      ? '你是专业翻译。将用户给出的中文翻译成地道英文。只输出译文，不要解释。'
      : '你是专业翻译。将用户给出的英文翻译成自然中文。只输出译文，不要解释。'

  const base = String(settings.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, '')
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: settings.model || DEFAULTS.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text.trim() },
      ],
      temperature: 0.2,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`DeepSeek 请求失败 (${res.status}): ${body.slice(0, 160)}`)
  }

  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('DeepSeek 返回为空')
  return content
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'translate') {
    translate(message.text, message.direction || 'en-zh')
      .then((translation) => sendResponse({ ok: true, translation }))
      .catch((err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
    return true
  }

  if (message?.type === 'getSettings') {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
    return true
  }

  return false
})
