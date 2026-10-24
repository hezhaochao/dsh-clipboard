# dsh-clipboard — 剪贴板轮询器（Windows）
#
# 由宿主半边或 MCP 服务器以「分离进程」拉起；也支持 -Once 单次扫描（测试用）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File clipboard-watch.ps1
#   powershell ... -File clipboard-watch.ps1 -Once
#
# 行为：
#   - 每 1.5s 读一次系统剪贴板（Get-Clipboard，只取文本；图片/文件忽略）
#   - 与上一条不同才追加到 ~/.dsh/dsh-clipboard/history.jsonl（JSONL：{"t":毫秒,"text":...}）
#   - 修剪：最多 50 条、单条 8000 字符、超过 4 小时的条目删除（写时重写文件）
#   - 单实例：watch.lock 记 PID，进程存活则直接退出；死锁自动接管
# 隐私：历史只落本地文件，永不联网；清空 = 删文件（网页组件与 README 有说明）。
# 注意：本文件必须保存为 UTF-8 with BOM（PS 5.1 编码坑，真机踩过）。
param(
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$dir = Join-Path $env:USERPROFILE '.dsh\dsh-clipboard'
$file = Join-Path $dir 'history.jsonl'
$lock = Join-Path $dir 'watch.lock'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$MAX_ITEMS = 50
$MAX_TEXT = 8000
$MAX_AGE_MS = 4 * 60 * 60 * 1000
$POLL_MS = 1500

function Out-Json($object) {
  $json = $object | ConvertTo-Json -Compress -Depth 4
  # stdout 只输出纯 ASCII（非 ASCII 转 \uXXXX），父子进程编码不同也不会坏
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $json.ToCharArray()) {
    if ([int]$ch -gt 127) {
      [void]$sb.Append(('\u' + ([int]$ch).ToString('x4')))
    } else {
      [void]$sb.Append($ch)
    }
  }
  Write-Output $sb.ToString()
}

function Read-History {
  $items = New-Object System.Collections.ArrayList
  if (Test-Path -LiteralPath $file) {
    foreach ($line in (Get-Content -LiteralPath $file -Encoding UTF8)) {
      $t = $line.Trim()
      if (-not $t) { continue }
      try {
        $obj = $t | ConvertFrom-Json
        $num = 0
        if ([long]::TryParse([string]$obj.t, [ref]$num) -and $null -ne $obj.text) {
          [void]$items.Add(@{ t = $num; text = [string]$obj.text })
        }
      } catch { }
    }
  }
  return ,$items
}

function Write-History($items) {
  $lines = foreach ($it in $items) {
    $json = @{ t = $it.t; text = $it.text } | ConvertTo-Json -Compress -Depth 3
    $json
  }
  [IO.File]::WriteAllLines($file, $lines, (New-Object System.Text.UTF8Encoding $false))
}

function Get-ClipText {
  try {
    $t = Get-Clipboard -Raw -ErrorAction Stop
    if ($null -eq $t) { return $null }
    $s = [string]$t
    if ($s.Length -gt $MAX_TEXT) { $s = $s.Substring(0, $MAX_TEXT) }
    if ($s.Trim().Length -eq 0) { return $null }
    return $s
  } catch {
    # 剪贴板里是非文本（图片/文件）时 Get-Clipboard 会抛错：忽略这一轮
    return $null
  }
}

function Invoke-Scan {
  $items = Read-History
  $cur = Get-ClipText
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $changed = $false
  $last = if ($items.Count -gt 0) { $items[$items.Count - 1].text } else { '' }
  if ($null -ne $cur -and $cur -cne $last) {
    [void]$items.Add(@{ t = $now; text = $cur })
    $changed = $true
  }
  # 修剪：时间与条数
  $cutoff = $now - $MAX_AGE_MS
  $kept = New-Object System.Collections.ArrayList
  foreach ($it in $items) {
    if ($it.t -ge $cutoff) { [void]$kept.Add($it) }
  }
  if ($kept.Count -gt $MAX_ITEMS) {
    $tail = @($kept | Select-Object -Last $MAX_ITEMS)
    $kept = New-Object System.Collections.ArrayList
    foreach ($it in $tail) { [void]$kept.Add($it) }
  }
  if ($changed -or $kept.Count -ne $items.Count) {
    Write-History $kept
  }
  return @{ changed = $changed; count = $kept.Count }
}

if ($Once) {
  $r = Invoke-Scan
  Out-Json @{ ok = $true; once = $true; changed = $r.changed; count = $r.count }
  exit 0
}

# ── 常驻模式：单实例锁 ──
if (Test-Path -LiteralPath $lock) {
  $lockRaw = (Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue) | ConvertFrom-Json -ErrorAction SilentlyContinue
  $oldPid = 0
  if ($null -ne $lockRaw) { [void][int]::TryParse([string]$lockRaw.pid, [ref]$oldPid) }
  if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Out-Json @{ ok = $true; alreadyRunning = $true; pid = $oldPid }
    exit 0
  }
}
[IO.File]::WriteAllText($lock, (@{ pid = $PID; t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))

try {
  while ($true) {
    try { [void](Invoke-Scan) } catch { }
    Start-Sleep -Milliseconds $POLL_MS
  }
} finally {
  $lockRaw = (Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue) | ConvertFrom-Json -ErrorAction SilentlyContinue
  if ($null -ne $lockRaw -and [string]$lockRaw.pid -eq [string]$PID) {
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
  }
}
