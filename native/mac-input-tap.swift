// macOS 全局输入监听辅助程序（只读）。
//
// 为什么不用 uiohook：它在 macOS 上创建的是「主动拦截」事件 tap（kCGEventTapOptionDefault），
// 所有鼠标事件都要先经过它的回调才继续分发；在 macOS 27 上这会让窗口标题栏拖动失效。
// 这里改用只读 tap（listenOnly）：系统只把事件副本发给我们，不等待、不修改原事件。
//
// 输出：每个事件一行 JSON 到 stdout
//   {"t":"md"|"mu","b":1,"x":123.5,"y":456}         鼠标按下 / 松开（全局点坐标，左上角为原点）
//   松开时额外带 "wm":1 表示这次拖动移动 / 缩放了窗口（拖标题栏），不是选文字
//   {"t":"kd"|"ku","k":<macOS 虚拟键码>,"f":<CGEventFlags>}  键盘按下 / 松开（含修饰键变化）
//   {"t":"ready"} 启动成功；{"t":"error","m":"..."} 失败后退出码 2
// stdin 关闭（父进程退出）时自动退出。

import Cocoa

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

var tap: CFMachPort?

// 修饰键键码 → 对应的 flag 位，用来判断 flagsChanged 是按下还是松开
let modifierFlag: [Int64: UInt64] = [
    55: CGEventFlags.maskCommand.rawValue, 54: CGEventFlags.maskCommand.rawValue,
    56: CGEventFlags.maskShift.rawValue, 60: CGEventFlags.maskShift.rawValue,
    58: CGEventFlags.maskAlternate.rawValue, 61: CGEventFlags.maskAlternate.rawValue,
    59: CGEventFlags.maskControl.rawValue, 62: CGEventFlags.maskControl.rawValue,
    57: CGEventFlags.maskAlphaShift.rawValue,
]

/** 光标下最上层的普通窗口（layer 0）的编号与位置 */
func windowAt(_ p: CGPoint) -> (id: Int, frame: CGRect)? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return nil }
    for w in list {
        guard (w[kCGWindowLayer as String] as? Int) == 0,
              let id = w[kCGWindowNumber as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let frame = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        if frame.contains(p) { return (id, frame) }
    }
    return nil
}

func windowFrame(_ id: Int) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
          let b = list.first?[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
    return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
}

var pressedWindow: (id: Int, frame: CGRect)?

let callback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
    case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp:
        let p = event.location
        let isDown = type == .leftMouseDown || type == .rightMouseDown
        let button = (type == .leftMouseDown || type == .leftMouseUp) ? 1 : 2
        var extra = ""
        if type == .leftMouseDown {
            pressedWindow = windowAt(p)
        } else if type == .leftMouseUp, let pw = pressedWindow {
            if let now = windowFrame(pw.id), now != pw.frame { extra = ",\"wm\":1" }
            pressedWindow = nil
        }
        emit("{\"t\":\"\(isDown ? "md" : "mu")\",\"b\":\(button),\"x\":\(p.x),\"y\":\(p.y)\(extra)}")
    case .keyDown, .keyUp:
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let f = event.flags.rawValue
        emit("{\"t\":\"\(type == .keyDown ? "kd" : "ku")\",\"k\":\(code),\"f\":\(f)}")
    case .flagsChanged:
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let f = event.flags.rawValue
        if let bit = modifierFlag[code] {
            emit("{\"t\":\"\((f & bit) != 0 ? "kd" : "ku")\",\"k\":\(code),\"f\":\(f)}")
        }
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

let types: [CGEventType] = [
    .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .keyDown, .keyUp, .flagsChanged,
]
let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }

guard let created = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .tailAppendEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: nil
) else {
    emit("{\"t\":\"error\",\"m\":\"无法创建事件监听，请在「系统设置 → 隐私与安全性」中授予辅助功能 / 输入监控权限\"}")
    exit(2)
}
tap = created

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: created, enable: true)

// 父进程退出时 stdin 会关闭，随之退出，避免残留
DispatchQueue.global().async {
    while FileHandle.standardInput.availableData.count > 0 {}
    exit(0)
}

emit("{\"t\":\"ready\"}")
CFRunLoopRun()
