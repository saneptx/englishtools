# English Tools

桌面英语学习工具（**Windows / macOS**）：**系统级划词翻译**（任意软件选中英文 → 附近弹出中文）+ 打字时中文自动译英文 + 截图 OCR 翻译。翻译使用 DeepSeek API。


## 功能

1. **系统划词英译汉**：后台托盘 / 菜单栏常驻，监测鼠标拖选；松手后读取选中文本并在选区下方弹出中文
2. **打字译英**：在任意输入框输入中文（上屏后），停顿片刻即在下方弹出英文，可一键替换回输入框
3. **截图翻译**：快捷键框选屏幕区域，用系统自带的文字识别（macOS Vision / Windows OCR）识别后翻译。Windows 需装有英文语言包（英文版及多数中文版默认已有）
4. **翻译输入框快捷键**（macOS `⌥T` / Windows `Ctrl+Alt+T`）：手动翻译当前输入框全部内容，回车替换为译文。读不到输入框的应用会用「全选 → 复制」读取（恢复剪贴板）
5. 译文卡片快捷键：朗读 / 替换 / 复制分别为 `Alt+1/2/3`（macOS 为 `⌥1/2/3`），`Esc` 关闭
6. **YouTube 学习**（托盘菜单 / 设置页打开）：粘贴视频链接，左侧播放视频，右侧是随播放滚动的双语字幕——当前句高亮、逐词跟读描边、AI 标出重点词，点单词查看释义，可收藏句子；`空格` 播放暂停，`← →` 切句，`R` 重播本句
7. 可在设置 / 托盘菜单开关「划词翻译」「打字译英」

> 说明：划词优先通过系统无障碍接口（Windows UI Automation / macOS Accessibility）直接读取选区，读不到时才回退为「模拟复制 → 读剪贴板 → 恢复剪贴板」。图片/视频内不可选文字请用截图翻译。

## 平台差异

| | Windows | macOS |
|---|---|---|
| 选区 / 输入框读取 | PowerShell + UI Automation | osascript + System Events (AX 属性) |
| 截图翻译默认快捷键 | `Ctrl+Shift+S` | `⌥⇧S`（`Alt+Shift+S`） |
| 截图文字识别 | Windows.Media.Ocr | Vision |
| 常驻位置 | 系统托盘 | 菜单栏（设置窗口打开时才显示 Dock 图标） |

### macOS 权限

首次运行需要在「系统设置 → 隐私与安全性」中授予：

- **辅助功能**：全局监听鼠标/键盘、读取选中文本、模拟 ⌘C / ⌘V。未授权时设置页会提示，授权后自动生效。
- **自动化 → System Events**：首次划词时系统会弹窗询问，选择允许。
- **屏幕录制**：截图翻译需要，授权后需重启应用。

开发模式下这些权限记在启动它的程序名下（例如从终端运行就是「终端」/ iTerm，从编辑器内置终端运行就是对应编辑器），而不是 Electron。

某个应用里打字译英不生效时，可在已授权的终端运行诊断脚本，倒计时内切到该应用的输入框输入几个中文字，看它暴露了哪些无障碍信息：

```bash
bash scripts/mac-ax-probe.sh
```

`npm run dev` 的终端里会打印每次打字检测的结果（`[input] ok/nofocus/noneditable ...`、`[ocr] ...`）。

**微信（4.x）**：它是 Qt 自绘界面，不暴露任何无障碍信息。macOS 上自动打字译英改为**截屏识别**：截取微信窗口底部 → 按底色定位输入框 → 用系统 Vision 框架识别文字（约 0.2 秒，不发按键、不碰剪贴板，需要「屏幕录制」权限）。译文卡片设置为不出现在截屏中，避免被自己识别进去（副作用：你自己截图 / 录屏时也看不到它）。输入法还在拼音组合阶段（最后一键是字母）时不会识别。Windows 上自动打字译英不支持微信（会直接跳过），微信里请用「翻译输入框」快捷键。

Linux 仅做了基础兼容（划词读取 PRIMARY 选区），打字译英与替换暂不支持，未经测试。

## YouTube 学习的字幕来源

1. **YouTube 自带字幕**（大多数视频）：通过 YouTube 移动端接口获取。有人工字幕时用人工字幕的文本（标点准确），并与自动字幕按词对齐借用逐词时间；只有自动字幕时按停顿断句。几秒内即可开始。
2. **语音识别**（没有英文字幕的视频）：yt-dlp 下载音频 → ffmpeg 转码 → whisper.cpp 本地逐词识别，首次使用自动下载 `ggml-base.en` 模型（约 150MB）。需自行安装工具：
   - macOS：`brew install yt-dlp ffmpeg whisper-cpp`
   - Windows：`winget install yt-dlp.yt-dlp Gyan.FFmpeg`，whisper.cpp 从 GitHub Releases 下载并把 `whisper-cli.exe` 加入 PATH

字幕翻译和重点词由 DeepSeek 分批生成（边看边出），结果按视频缓存，再次打开无需重新翻译。最近 20 个视频保留缓存。

## 安装

### 下载安装包
在 GitHub 仓库的 **Actions → Build installers → Run workflow** 运行一次（或推送 `v1.0.1` 这样的标签），完成后在运行页面底部的 Artifacts 下载：

- macOS：`English Tools-x.y.z-arm64.dmg`（Apple Silicon）/ `-x64.dmg`（Intel），打开后把 English Tools 拖进「应用程序」
- Windows：`English Tools Setup x.y.z.exe` 安装包，或 `-win.zip` 免安装版（解压后运行 `English Tools.exe`）

安装包未做代码签名：
- macOS：从 GitHub 下载的 dmg 带有「隔离」标记，而安装包只做了 ad-hoc 签名、没有经过苹果公证，Gatekeeper 会拒绝打开（提示「已损坏」「无法验证开发者」或点了没反应）。拖进「应用程序」后在终端运行一次：
  ```bash
  xattr -dr com.apple.quarantine "/Applications/English Tools.app"
  ```
  要彻底免去这一步，需要用 Apple 开发者账号（付费）做 Developer ID 签名和公证。
- macOS 安装包用固定的自签名证书签名（见下方「macOS 签名证书」），更新版本后辅助功能 / 屏幕录制权限依然有效；从旧的 ad-hoc 版本升级上来时需要最后一次重新授权
- macOS 最低支持 13（Ventura）；Intel 与 Apple Silicon 分别下载对应的 dmg
- Windows 若弹出 SmartScreen，点「更多信息 → 仍要运行」

安装版的权限记在 English Tools 名下（不再是终端）。设置页「通用 → 开机自动启动」可设为登录后在后台启动。

### 本地打包

```bash
npm run dist:mac   # macOS：release/*.dmg（需 Xcode 命令行工具，用于编译输入监听辅助程序）
npm run dist:win   # Windows 上运行：release/*.exe 安装包 + *.zip 免安装版
```

### macOS 签名证书

ad-hoc 签名每次打包指纹都不同，系统会把新版本当成另一个 App，权限随之失效。打包时 `scripts/mac-sign.js`（electron-builder 的 afterSign 钩子）会改用一张固定的自签名代码签名证书重新签名，系统按「Bundle ID + 证书」识别，更新后权限保留。证书导入临时钥匙串，签完即删，不改动登录钥匙串。

- 本地打包：证书放在 `~/.englishtools-signing/cert.p12`，密码在同目录 `password.txt`（不在仓库里）
- GitHub Actions：在仓库 **Settings → Secrets and variables → Actions** 添加 `MAC_SIGN_P12_BASE64`（`base64 -i ~/.englishtools-signing/cert.p12` 的输出）和 `MAC_SIGN_PASSWORD`
- 找不到证书时退回 ad-hoc 签名并打印提示。**证书务必备份且不要更换**，换证书等于换了身份，所有用户都要重新授权

在 Apple Silicon Mac 上交叉打包 Windows 只能生成 zip 免安装版：NSIS 安装包的编译器是 Intel 程序，需要先安装 Rosetta（`softwareupdate --install-rosetta`）。

## 开发运行

```bash
npm install
npm run dev
```

首次在「设置」填写 DeepSeek API Key。关闭主窗口会隐藏到托盘 / 菜单栏，从菜单中「退出」才真正退出。

调试时可用 `ENGLISHTOOLS_OPEN_LEARN=<视频链接或ID>` 启动，直接打开学习窗口并加载该视频。

`npm install` 后 `scripts/ensure-electron.js` 会检查 Electron 二进制是否完整（macOS 上 extract-zip 偶尔会丢 Framework），不完整时自动从缓存修复。

## 可选

`extension/` 目录是早期浏览器扩展原型，**不是**当前主方案；系统划词请用 Electron 桌面端。
