import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * 全局鼠标 / 键盘事件来源，对外统一成 uiohook 的事件形状（键码用 uiohook 的 VC_ 码）。
 * - Windows / Linux：uiohook-napi
 * - macOS：只读监听辅助程序 native/bin/mac-input-tap（uiohook 在 macOS 上是主动拦截 tap，
 *   会让 macOS 27 的窗口拖动失效）
 */

export interface MouseEvt {
  button: number
  x: number
  y: number
  /** 这次按下到松开之间窗口被移动 / 缩放了（拖标题栏），仅 macOS 提供 */
  windowMoved?: boolean
}

export interface KeyEvt {
  keycode: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

type Handlers = {
  mousedown: (e: MouseEvt) => void
  mouseup: (e: MouseEvt) => void
  keydown: (e: KeyEvt) => void
  keyup: (e: KeyEvt) => void
}

export interface InputSource {
  on<K extends keyof Handlers>(type: K, cb: Handlers[K]): void
  start(): void
  stop(): void
}

// ───────────────── macOS 虚拟键码 → uiohook VC_ 码 ─────────────────
const MAC_TO_VC: Record<number, number> = {
  // 字母
  0: 30, 11: 48, 8: 46, 2: 32, 14: 18, 3: 33, 5: 34, 4: 35, 34: 23, 38: 36, 40: 37, 37: 38, 46: 50,
  45: 49, 31: 24, 35: 25, 12: 16, 15: 19, 1: 31, 17: 20, 32: 22, 9: 47, 13: 17, 7: 45, 16: 21, 6: 44,
  // 数字
  18: 2, 19: 3, 20: 4, 21: 5, 23: 6, 22: 7, 26: 8, 28: 9, 25: 10, 29: 11,
  // 控制键
  53: 1, // Esc
  48: 15, // Tab
  36: 28, // Return
  49: 57, // Space
  51: 14, // Delete（退格）
  117: 3667, // Forward delete
  // 修饰键
  55: 3675, 54: 3676, // Command L/R → Meta
  56: 42, 60: 54, // Shift L/R
  58: 56, 61: 3640, // Option L/R → Alt
  59: 29, 62: 3613, // Control L/R
  57: 58, // CapsLock
  // F1-F12
  122: 59, 120: 60, 99: 61, 118: 62, 96: 63, 97: 64, 98: 65, 100: 66, 101: 67, 109: 68, 103: 87, 111: 88,
  // 导航
  115: 3655, 116: 3657, 119: 3663, 121: 3665, 114: 3666,
  126: 57416, 123: 57419, 124: 57421, 125: 57424,
}

const FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 }

function helperPath() {
  const candidates = [
    join(app.getAppPath(), 'native', 'bin', 'mac-input-tap'),
    join(process.resourcesPath || '', 'native', 'bin', 'mac-input-tap'),
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

function createMacSource(): InputSource {
  const handlers: { [K in keyof Handlers]: Handlers[K][] } = {
    mousedown: [],
    mouseup: [],
    keydown: [],
    keyup: [],
  }
  let child: ChildProcess | null = null
  let stopped = false
  let restarts = 0

  const dispatch = (line: string) => {
    let m: { t: string; b?: number; x?: number; y?: number; k?: number; f?: number; m?: string; wm?: number }
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.t === 'md' || m.t === 'mu') {
      const e: MouseEvt = { button: m.b ?? 1, x: m.x ?? 0, y: m.y ?? 0, windowMoved: m.wm === 1 }
      for (const cb of handlers[m.t === 'md' ? 'mousedown' : 'mouseup']) cb(e)
    } else if (m.t === 'kd' || m.t === 'ku') {
      const f = m.f ?? 0
      const k = m.k ?? -1
      const e: KeyEvt = {
        // 未映射的键给一个不会和 VC_ 码冲突的值，按「普通输入键」处理
        keycode: MAC_TO_VC[k] ?? 0x10000 + k,
        shiftKey: !!(f & FLAG.shift),
        ctrlKey: !!(f & FLAG.ctrl),
        altKey: !!(f & FLAG.alt),
        metaKey: !!(f & FLAG.cmd),
      }
      for (const cb of handlers[m.t === 'kd' ? 'keydown' : 'keyup']) cb(e)
    } else if (m.t === 'error') {
      console.error('[input] mac-input-tap:', m.m)
    }
  }

  const launch = () => {
    const bin = helperPath()
    if (!existsSync(bin)) {
      console.error(`[input] 找不到 ${bin}，请运行 npm run build:mac-helper`)
      return
    }
    // stdin 保持打开：本进程退出时管道关闭，辅助程序随之退出
    const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    child = proc
    createInterface({ input: proc.stdout! }).on('line', dispatch)
    proc.on('exit', (code) => {
      if (child === proc) child = null
      // 意外退出时重启（权限问题 code=2 不重启）
      if (!stopped && code !== 2 && restarts++ < 5) setTimeout(launch, 1000)
    })
  }

  return {
    on(type, cb) {
      ;(handlers[type] as unknown[]).push(cb)
    },
    start() {
      stopped = false
      if (!child) launch()
    },
    stop() {
      stopped = true
      child?.kill()
      child = null
    },
  }
}

function createUiohookSource(): InputSource {
  // 延迟加载：macOS 上完全不加载 uiohook 的原生模块
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi')
  return {
    on(type, cb) {
      uIOhook.on(type, cb as never)
    },
    start() {
      uIOhook.start()
    },
    stop() {
      try {
        uIOhook.stop()
      } catch {
        /* ignore */
      }
    },
  }
}

export function createInputSource(): InputSource {
  return process.platform === 'darwin' ? createMacSource() : createUiohookSource()
}
