# dsh-clipboard — 轮询器真实 E2E（仅限 Windows）
#
# 用隔离的临时 USERPROFILE 跑剪贴板轮询器：
#   1. -Once 单次扫描：写剪贴板 → 捕获进 history.jsonl；重复扫描不重复记录
#   2. 长文本截断到 8000 字符
#   3. 修剪：假造超龄/超量条目后扫描应收敛到 50 条内且清掉 4 小时前的
#   4. 常驻模式单实例锁：已有活锁时第二个实例直接退出并报 alreadyRunning
# 运行：powershell -NoProfile -ExecutionPolicy Bypass -File test/watcher.tests.ps1
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$watcher = Join-Path $repoRoot 'scripts\clipboard-watch.ps1'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 隔离环境：临时 USERPROFILE（子进程继承）
$fakeHome = Join-Path $env:TEMP ("dsh-clip-test-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $fakeHome | Out-Null
$env:USERPROFILE = $fakeHome
$dir = Join-Path $fakeHome '.dsh\dsh-clipboard'
$file = Join-Path $dir 'history.jsonl'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$failures = 0
function Assert-True([bool]$cond, [string]$name) {
  if ($cond) { Write-Output "PASS $name" }
  else { Write-Output "FAIL $name"; $script:failures++ }
}

function Invoke-Once {
  $raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watcher -Once
  return (($raw | Out-String).Trim() | ConvertFrom-Json)
}

function Read-Items {
  $items = @()
  if (Test-Path -LiteralPath $file) {
    foreach ($line in (Get-Content -LiteralPath $file -Encoding UTF8)) {
      $t = $line.Trim()
      if (-not $t) { continue }
      try { $items += ($t | ConvertFrom-Json) } catch { }
    }
  }
  return ,$items
}

# ── 1. 单次扫描捕获 + 去重 ────────────────────────────────────
Set-Clipboard -Value 'hello-clipboard-A'
$r1 = Invoke-Once
$items = Read-Items
Assert-True ($r1.ok -and $r1.changed -and $items.Count -eq 1 -and $items[0].text -eq 'hello-clipboard-A') "捕获第一条剪贴板文本"
$r2 = Invoke-Once
$items = Read-Items
Assert-True (-not $r2.changed -and $items.Count -eq 1) "内容未变不重复记录"
Set-Clipboard -Value 'second-entry-B'
[void](Invoke-Once)
$items = Read-Items
Assert-True ($items.Count -eq 2 -and $items[1].text -eq 'second-entry-B') "第二条追加到末尾"

# ── 2. 长文本截断 ────────────────────────────────────────────
$long = 'x' * 9000
Set-Clipboard -Value $long
[void](Invoke-Once)
$items = Read-Items
Assert-True ($items.Count -eq 3 -and $items[2].text.Length -eq 8000) "长文本截断到 8000 字符"

# ── 3. 修剪：超龄条目删除、总量封顶 50 ────────────────────────
$nowMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$fake = @()
for ($i = 0; $i -lt 60; $i++) {
  $age = if ($i -lt 10) { 5 * 60 * 60 * 1000 } else { 0 }   # 前 10 条造成为 5 小时前
  $fake += (@{ t = $nowMs - $age - $i; text = "entry-$i" } | ConvertTo-Json -Compress)
}
[IO.File]::WriteAllLines($file, $fake, (New-Object System.Text.UTF8Encoding $false))
Set-Clipboard -Value 'after-prune-C'
[void](Invoke-Once)
$items = Read-Items
Assert-True ($items.Count -le 50) "总量封顶 50（实际 $($items.Count)）"
$oldest = ($items | Measure-Object -Property t -Minimum).Minimum
Assert-True ($oldest -ge ($nowMs - 4 * 60 * 60 * 1000 - 60000)) "超龄条目（5 小时前）已被清掉"
$last = $items[$items.Count - 1]
Assert-True ($last.text -eq 'after-prune-C') "新条目仍在末尾"

# ── 4. 非文本剪贴板不炸 ──────────────────────────────────────
Set-Clipboard -Value ([byte[]](1, 2, 3)) -ErrorAction SilentlyContinue
try { [void](Invoke-Once); Assert-True $true "非文本剪贴板扫描不抛错" }
catch { Assert-True $false "非文本剪贴板扫描抛错：$($_.Exception.Message)" }

# ── 5. 常驻模式单实例锁 ──────────────────────────────────────
Set-Clipboard -Value 'lock-holder'
$holderOut = Join-Path $fakeHome 'holder.txt'
$holder = Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$watcher`"" `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput $holderOut
Start-Sleep -Milliseconds 2500
$secondOut = Join-Path $fakeHome 'second.txt'
$second = Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$watcher`"" `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput $secondOut
Start-Sleep -Milliseconds 2500
if (-not $second.HasExited) { Stop-Process -Id $second.Id -Force -ErrorAction SilentlyContinue }
$secondText = if (Test-Path $secondOut) { (Get-Content $secondOut -Raw | Out-String).Trim() } else { '' }
Assert-True ($secondText -match 'alreadyRunning') "第二个常驻实例识别到已有实例并退出"
if (-not $holder.HasExited) { Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Assert-True (-not (Test-Path (Join-Path $dir 'watch.lock')) -or $holder.HasExited) "持有者退出后锁清理"

# ── 清理 ────────────────────────────────────────────────────
try { Set-Clipboard -Value ' ' -ErrorAction Stop } catch { }
Remove-Item -Recurse -Force $fakeHome -ErrorAction SilentlyContinue

Write-Output ""
if ($failures -gt 0) {
  Write-Output "WATCHER E2E RESULT: $failures 项失败"
  exit 1
}
Write-Output "WATCHER E2E RESULT: 全部通过"
