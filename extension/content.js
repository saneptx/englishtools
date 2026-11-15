;(() => {
  const ROOT_ID = 'english-tools-select-root'
  let hideTimer = null
  let reqId = 0
  let lastText = ''

  function ensureRoot() {
    let el = document.getElementById(ROOT_ID)
    if (el) return el
    el = document.createElement('div')
    el.id = ROOT_ID
    el.className = 'et-root'
    document.documentElement.appendChild(el)
    return el
  }

  function hide() {
    const el = document.getElementById(ROOT_ID)
    if (el) el.remove()
  }

  function getSelectedTextAndRect() {
    const active = document.activeElement
    if (
      active &&
      (active.tagName === 'TEXTAREA' ||
        (active.tagName === 'INPUT' &&
          /^(text|search|url|email|password)$/i.test(active.type || 'text')))
    ) {
      const start = active.selectionStart ?? 0
      const end = active.selectionEnd ?? 0
      if (end > start) {
        const text = String(active.value || '').slice(start, end)
        const box = active.getBoundingClientRect()
        return { text, box }
      }
    }

    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const text = sel.toString()
    const range = sel.getRangeAt(0)
    const box = range.getBoundingClientRect()
    return { text, box }
  }

  function placeBubble(box) {
    const root = ensureRoot()
    const pad = 8
    const maxW = Math.min(420, window.innerWidth - 24)
    let left = box.left + window.scrollX
    const preferBelow = box.bottom + 140 < window.innerHeight

    if (left + maxW > window.scrollX + window.innerWidth - 12) {
      left = window.scrollX + window.innerWidth - maxW - 12
    }
    left = Math.max(window.scrollX + 12, left)

    root.dataset.place = preferBelow ? 'below' : 'above'
    root.dataset.boxTop = String(box.top + window.scrollY)
    root.dataset.boxBottom = String(box.bottom + window.scrollY)
    root.style.left = `${left}px`
    root.style.width = `${Math.max(180, Math.min(maxW, Math.max(box.width, 220)))}px`
    root.style.top = preferBelow
      ? `${box.bottom + window.scrollY + pad}px`
      : `${box.top + window.scrollY - pad}px`
    return root
  }

  function render(root, { source, loading, translation, error }) {
    root.innerHTML = ''
    const card = document.createElement('div')
    card.className = 'et-card'

    const head = document.createElement('div')
    head.className = 'et-head'
    const title = document.createElement('span')
    title.textContent = '中文翻译'
    head.appendChild(title)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'et-close'
    close.textContent = '×'
    close.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      hide()
    })
    head.appendChild(close)
    card.appendChild(head)

    if (source) {
      const src = document.createElement('div')
      src.className = 'et-source'
      src.textContent = source
      card.appendChild(src)
    }

    const body = document.createElement('div')
    body.className = 'et-body'
    if (loading) body.textContent = '翻译中…'
    else if (error) {
      body.classList.add('et-error')
      body.textContent = error
    } else body.textContent = translation || ''
    card.appendChild(body)
    root.appendChild(card)

    if (root.dataset.place === 'above') {
      const boxTop = parseFloat(root.dataset.boxTop || '0')
      root.style.top = `${boxTop - root.offsetHeight - 8}px`
    }
  }

  async function translateSelection(text, box) {
    const id = ++reqId
    lastText = text
    const root = placeBubble(box)
    render(root, { source: text, loading: true })

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'translate',
        text,
        direction: 'en-zh',
      })
      if (id !== reqId || lastText !== text) return
      if (!res?.ok) {
        render(root, { source: text, error: res?.error || '翻译失败' })
        return
      }
      render(root, { source: text, translation: res.translation })
    } catch (err) {
      if (id !== reqId) return
      render(root, {
        source: text,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  document.addEventListener(
    'mouseup',
    (e) => {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      if (e.button !== 0) return
      if (e.target instanceof Element && e.target.closest(`#${ROOT_ID}`)) return

      setTimeout(() => {
        const picked = getSelectedTextAndRect()
        if (!picked) return
        const text = picked.text.replace(/\s+/g, ' ').trim()
        if (!text || text.length > 2000) return
        if (!/[A-Za-z\u00C0-\u024F]/.test(text)) return
        if (picked.box.width === 0 && picked.box.height === 0) return

        void chrome.storage.sync.get({ enabled: true }).then((cfg) => {
          if (cfg.enabled === false) return
          void translateSelection(text, picked.box)
        })
      }, 10)
    },
    true,
  )

  document.addEventListener(
    'mousedown',
    (e) => {
      const root = document.getElementById(ROOT_ID)
      if (root && e.target instanceof Node && root.contains(e.target)) return
      hideTimer = setTimeout(hide, 0)
    },
    true,
  )

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide()
  })

  window.addEventListener(
    'scroll',
    () => {
      hide()
    },
    true,
  )
})()
