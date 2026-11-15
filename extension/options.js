const enabledEl = document.getElementById('enabled')
const apiKeyEl = document.getElementById('apiKey')
const baseUrlEl = document.getElementById('baseUrl')
const modelEl = document.getElementById('model')
const msg = document.getElementById('msg')

chrome.storage.sync.get(
  {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  (data) => {
    enabledEl.checked = data.enabled !== false
    apiKeyEl.value = data.apiKey || ''
    baseUrlEl.value = data.baseUrl || 'https://api.deepseek.com'
    modelEl.value = data.model || 'deepseek-chat'
  },
)

document.getElementById('save').addEventListener('click', () => {
  msg.textContent = ''
  msg.classList.remove('error')
  chrome.storage.sync.set(
    {
      enabled: enabledEl.checked,
      apiKey: apiKeyEl.value.trim(),
      baseUrl: baseUrlEl.value.trim() || 'https://api.deepseek.com',
      model: modelEl.value.trim() || 'deepseek-chat',
    },
    () => {
      if (chrome.runtime.lastError) {
        msg.textContent = chrome.runtime.lastError.message
        msg.classList.add('error')
        return
      }
      msg.textContent = '已保存'
    },
  )
})
