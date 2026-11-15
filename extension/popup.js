const cn = document.getElementById('cn')
const en = document.getElementById('en')
const copyBtn = document.getElementById('copy')
const status = document.getElementById('status')

let timer = null
let req = 0
let latestEn = ''

function setStatus(text, isError = false) {
  status.textContent = text || ''
  status.classList.toggle('error', !!isError)
}

async function translateNow(text) {
  const trimmed = text.trim()
  if (!trimmed) {
    en.textContent = '译文将显示在这里'
    latestEn = ''
    copyBtn.disabled = true
    setStatus('')
    return
  }

  const id = ++req
  setStatus('翻译中…')
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'translate',
      text: trimmed,
      direction: 'zh-en',
    })
    if (id !== req) return
    if (!res?.ok) {
      en.textContent = ''
      latestEn = ''
      copyBtn.disabled = true
      setStatus(res?.error || '翻译失败', true)
      return
    }
    latestEn = res.translation
    en.textContent = latestEn
    copyBtn.disabled = !latestEn
    setStatus('')
  } catch (err) {
    if (id !== req) return
    setStatus(err instanceof Error ? err.message : String(err), true)
  }
}

cn.addEventListener('input', () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void translateNow(cn.value)
  }, 450)
})

copyBtn.addEventListener('click', async () => {
  if (!latestEn) return
  await navigator.clipboard.writeText(latestEn)
  setStatus('已复制')
})
