#!/bin/bash
# macOS 无障碍诊断：倒计时结束时打印前台应用焦点控件的 AX 信息。
# 用法：在已授予「辅助功能」权限的终端里运行，倒计时期间切到目标应用（如微信），
#       点进输入框并输入几个中文字。
#   bash scripts/mac-ax-probe.sh [秒数，默认 5]

secs=${1:-5}
for ((i = secs; i > 0; i--)); do
  printf '\r%d 秒后读取前台应用焦点控件…' "$i"
  sleep 1
done
echo

osascript <<'EOF'
set out to ""
tell application "System Events"
  set p to first application process whose frontmost is true
  set out to out & "app: " & (name of p) & linefeed
  try
    set out to out & "bundle: " & (bundle identifier of p) & linefeed
  end try
  try
    set w to value of attribute "AXFocusedWindow" of p
    set out to out & "window: " & (position of w as text) & " / " & (size of w as text) & linefeed
  on error e
    set out to out & "window: <" & e & ">" & linefeed
  end try
  try
    set f to value of attribute "AXFocusedUIElement" of p
  on error e
    return out & "AXFocusedUIElement: <" & e & ">"
  end try
  repeat with n in {"AXRole", "AXSubrole", "AXRoleDescription", "AXNumberOfCharacters", "AXSelectedTextRange", "AXSelectedText"}
    try
      set out to out & n & ": " & (value of attribute n of f as text) & linefeed
    on error e
      set out to out & n & ": <" & e & ">" & linefeed
    end try
  end repeat
  try
    set v to value of attribute "AXValue" of f
    if v is missing value then
      set out to out & "AXValue: <missing>" & linefeed
    else
      set v to v as text
      if length of v > 80 then set v to (text 1 thru 80 of v) & "…"
      set out to out & "AXValue: " & v & linefeed
    end if
  on error e
    set out to out & "AXValue: <" & e & ">" & linefeed
  end try
  try
    set out to out & "position/size: " & (position of f as text) & " / " & (size of f as text) & linefeed
  on error e
    set out to out & "position/size: <" & e & ">" & linefeed
  end try
  try
    set AppleScript's text item delimiters to ", "
    set out to out & "attributes: " & ((name of attributes of f) as text) & linefeed
  end try
end tell
return out
EOF
