import { getSettings } from './store'

export type TranslateDirection = 'zh-en' | 'en-zh'

export interface KeywordItem {
  word: string
  meaning: string
}

export interface AnnotatedSentence {
  en: string
  zh: string
  keywords: KeywordItem[]
}

async function chat(messages: { role: string; content: string }[], temperature = 0.2): Promise<string> {
  const settings = getSettings()
  if (!settings.apiKey?.trim()) {
    throw new Error('请先在设置中配置 DeepSeek API Key')
  }

  const base = settings.baseUrl.replace(/\/$/, '')
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: settings.model || 'deepseek-chat',
      messages,
      temperature,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`DeepSeek 请求失败 (${res.status}): ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('DeepSeek 返回为空')
  return content
}

export async function translate(text: string, direction: TranslateDirection): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ''

  const system =
    direction === 'zh-en'
      ? '你是专业翻译。将用户给出的中文翻译成地道英文。只输出译文，不要解释。'
      : '你是专业翻译。将用户给出的英文翻译成自然中文。只输出译文，不要解释。'

  return chat([
    { role: 'system', content: system },
    { role: 'user', content: trimmed },
  ])
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : raw.trim()
  return JSON.parse(body)
}

export async function annotateSentences(sentences: string[]): Promise<AnnotatedSentence[]> {
  if (sentences.length === 0) return []

  const batchSize = 12
  const results: AnnotatedSentence[] = []

  for (let i = 0; i < sentences.length; i += batchSize) {
    const batch = sentences.slice(i, i + batchSize)
    const system = `你是英语学习助手。对每句英文：给出中文翻译，并标注 1-3 个值得学习的重点词（动词/形容词/短语优先，跳过 the/a/is 等虚词）。
严格返回 JSON 数组，不要其它文字。格式：
[{"en":"...","zh":"...","keywords":[{"word":"...","meaning":"..."}]}]
en 必须与输入原句一致。`

    const raw = await chat([
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify(batch),
      },
    ])

    let parsed: AnnotatedSentence[]
    try {
      parsed = extractJson(raw) as AnnotatedSentence[]
      if (!Array.isArray(parsed)) throw new Error('not array')
    } catch {
      parsed = batch.map((en) => ({ en, zh: '', keywords: [] }))
    }

    for (let j = 0; j < batch.length; j++) {
      const item = parsed[j]
      results.push({
        en: batch[j],
        zh: item?.zh ?? '',
        keywords: Array.isArray(item?.keywords) ? item.keywords : [],
      })
    }
  }

  return results
}

export async function lookupWord(word: string, context?: string): Promise<string> {
  const system = '你是英语词典助手。用简洁中文解释英文单词/短语，给出词性、1-2 个常见释义和一句短例句。不要啰嗦。'
  const user = context ? `单词：${word}\n语境：${context}` : `单词：${word}`
  return chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])
}

export interface SubtitleTranslation {
  zh: string
  keywords: KeywordItem[]
}

/**
 * 视频字幕批量翻译：输入为连续的字幕行，结合上下文逐行翻译，并挑出值得学习的词或短语。
 * 返回数组与输入一一对应；模型返回格式不对时对应项为空，不抛错。
 */
export async function translateSubtitleLines(
  lines: string[],
  context: { title?: string; before?: string[] } = {},
): Promise<SubtitleTranslation[]> {
  if (!lines.length) return []
  const system = `你是英语学习视频的字幕助手。用户给出视频中连续的英文字幕行（JSON 数组，按时间顺序）。
对每一行：
1. zh：结合上下文给出自然、口语化的中文翻译，只翻译本行内容，不要合并或拆分行。
2. keywords：挑出 0-2 个值得中级英语学习者学习的单词或短语（较难词汇、习语、短语动词、地道搭配），跳过 the / is / very 之类的简单词；word 必须与本行原文中出现的写法完全一致，meaning 是它在这句话里的简短中文释义。
严格只返回 JSON 数组，长度必须与输入一致，不要任何其它文字：
[{"zh":"...","keywords":[{"word":"...","meaning":"..."}]}]`
  const ctx = [
    context.title ? `视频标题：${context.title}` : '',
    context.before?.length ? `前文（仅供理解，不要翻译）：${context.before.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const raw = await chat([
    { role: 'system', content: system },
    { role: 'user', content: `${ctx ? ctx + '\n\n' : ''}${JSON.stringify(lines)}` },
  ])

  let parsed: unknown
  try {
    parsed = extractJson(raw)
  } catch {
    parsed = []
  }
  const arr = Array.isArray(parsed) ? (parsed as Partial<SubtitleTranslation>[]) : []
  return lines.map((line, i) => {
    const item = arr[i] || {}
    const lower = line.toLowerCase()
    return {
      zh: typeof item.zh === 'string' ? item.zh : '',
      keywords: (Array.isArray(item.keywords) ? item.keywords : [])
        .filter((k) => k && typeof k.word === 'string' && typeof k.meaning === 'string')
        // 只保留确实出现在本行的词，便于在字幕里高亮
        .filter((k) => lower.includes(k.word.toLowerCase())),
    }
  })
}
