/**
 * 在聊天窗口底部截图（BGRA 位图）里定位输入框卡片。
 *
 * 思路（不依赖具体配色，浅色 / 深色都适用）：
 * 1. 只看窗口右侧 55%~95% 的横向范围（左侧是会话列表），逐行求「主色」；
 *    文字、图标只占一行里的少数像素，所以输入框内部每一行的主色都是输入框底色。
 * 2. 从底部往上找第一段足够高的、主色一致的连续行 —— 这就是输入框底色 C；
 *    继续向上扩展，直到主色连续两行不再是 C（碰到边框 / 分隔线 / 聊天区）。
 * 3. 在输入框中部的一行里，从中心向左右扩展到底色不再是 C 的位置，得到左右边界。
 */

export type PixelRect = { x: number; y: number; width: number; height: number }

type RGB = [number, number, number]

function px(buf: Buffer, w: number, x: number, y: number): RGB {
  const i = (y * w + x) * 4
  // BGRA
  return [buf[i + 2], buf[i + 1], buf[i]]
}

function close(a: RGB, b: RGB, tol: number) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol
}

/** 一行采样点里出现最多的颜色及其占比 */
function rowDominant(buf: Buffer, w: number, y: number, x0: number, x1: number, step: number) {
  const counts = new Map<number, { c: RGB; n: number }>()
  let total = 0
  for (let x = x0; x < x1; x += step) {
    const c = px(buf, w, x, y)
    // 量化到 4 级，吸收抗锯齿 / 渐变的细小差异
    const key = ((c[0] >> 2) << 12) | ((c[1] >> 2) << 6) | (c[2] >> 2)
    const e = counts.get(key)
    if (e) e.n++
    else counts.set(key, { c, n: 1 })
    total++
  }
  let best = { c: [0, 0, 0] as RGB, n: 0 }
  for (const e of counts.values()) if (e.n > best.n) best = e
  return { color: best.c, ratio: total ? best.n / total : 0 }
}

export interface DetectOptions {
  /** 位图像素 / 屏幕点，用于把以点为单位的阈值换成像素 */
  scale: number
}

export function findInputCard(buf: Buffer, w: number, h: number, opts: DetectOptions): PixelRect | null {
  const s = opts.scale || 1
  const x0 = Math.floor(w * 0.55)
  const x1 = Math.floor(w * 0.95)
  const step = Math.max(1, Math.round(2 * s))
  const tol = 6
  const minBlock = Math.round(40 * s)

  const rows = new Array(h)
  for (let y = 0; y < h; y++) rows[y] = rowDominant(buf, w, y, x0, x1, step)

  // 2. 从底部往上找第一段足够高的同色块
  let y = h - 1
  let bg: RGB | null = null
  let bottom = -1
  while (y >= 0 && !bg) {
    const start = y
    const c = rows[y].color
    while (y >= 0 && close(rows[y].color, c, tol)) y--
    if (start - y >= minBlock && rows[start].ratio > 0.5) {
      bg = c
      bottom = start
    }
  }
  if (!bg) return null

  // 向上扩展：允许中间夹杂文字行（主色仍是底色），连续 2 行主色不同即停
  let top = y + 1
  let miss = 0
  for (let yy = y; yy >= 0; yy--) {
    if (close(rows[yy].color, bg, tol)) {
      top = yy
      miss = 0
    } else if (++miss >= 2) {
      break
    }
  }
  const height = bottom - top + 1
  if (height < minBlock) return null

  // 3. 左右边界：取块内一个最「干净」的行（主色占比最高）
  let probeY = top
  let bestRatio = 0
  for (let yy = top; yy <= bottom; yy++) {
    if (rows[yy].ratio > bestRatio && close(rows[yy].color, bg, tol)) {
      bestRatio = rows[yy].ratio
      probeY = yy
    }
  }
  const cx = Math.floor((x0 + x1) / 2)
  const run = (dir: -1 | 1) => {
    let x = cx
    let miss = 0
    let last = cx
    while (x > 0 && x < w - 1) {
      x += dir
      if (close(px(buf, w, x, probeY), bg!, tol)) {
        last = x
        miss = 0
      } else if (++miss > 3) {
        break
      }
    }
    return last
  }
  const left = run(-1)
  const right = run(1)
  if (right - left < w * 0.3) return null
  return { x: left, y: top, width: right - left + 1, height }
}
