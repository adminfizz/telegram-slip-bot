# =====================================================
#  settings.ps1 — เมนูตั้งค่า Slip Bot (เขียนค่าลง .env ในเครื่อง ไม่ใช่บนเว็บ)
#  ค่า secret จะพิมพ์แบบไม่โชว์ และเก็บใน .env (gitignore ไม่ขึ้น GitHub)
#  รันเดี่ยวๆ:  powershell -ExecutionPolicy Bypass -File settings.ps1   (ตั้งค่าเสร็จ -> deploy local)
# =====================================================

function Sync-VercelEnv {
  # ดึง env ทั้งหมด (key setting) จากบัญชี Vercel ที่เคยตั้งไว้ -> เขียนลง .env
  param([string]$Dir, [string]$EnvPath)
  Push-Location $Dir
  Write-Host "[Vercel] เชื่อมโปรเจกต์ + ดึงค่าทั้งหมด (ถ้ายังไม่ล็อกอินจะให้ยืนยันผ่านเบราว์เซอร์) ..." -ForegroundColor Magenta
  try {
    if (-not (Test-Path (Join-Path $Dir '.vercel\project.json'))) { npx vercel link }
    npx vercel env pull $EnvPath --environment=production --yes
    Write-Host "[OK] ดึง key setting ทั้งหมดจาก Vercel ลง .env เรียบร้อย" -ForegroundColor Green
  } catch {
    Write-Host "[X] ดึงจาก Vercel ไม่สำเร็จ: $_" -ForegroundColor Red
    Write-Host "    ตรวจว่า: ติดตั้ง Node แล้ว + รัน 'npx vercel login' ด้วยบัญชีเดิมก่อน" -ForegroundColor Yellow
  }
  Pop-Location
}

function Invoke-SlipSettings {
  param([string]$Dir = (Get-Location).Path)

  $envPath     = Join-Path $Dir '.env'
  $examplePath = Join-Path $Dir '.env.example'
  if (-not (Test-Path $envPath)) {
    if (Test-Path $examplePath) { Copy-Item $examplePath $envPath } else { New-Item -ItemType File -Path $envPath | Out-Null }
  }

  $Fields = @(
    @{Key='TELEGRAM_BOT_TOKEN'; Label='Telegram Bot Token';        Secret=$true }
    @{Key='SPREADSHEET_ID';     Label='Google Spreadsheet ID';     Secret=$false}
    @{Key='GEMINI_API_KEY';     Label='Gemini API Key (OCR หลัก)';  Secret=$true }
    @{Key='OPENAI_API_KEY';     Label='OpenAI API Key (สำรอง)';     Secret=$true }
    @{Key='TYPHOON_API_KEY';    Label='Typhoon API Key (สำรอง)';    Secret=$true }
    @{Key='DASHBOARD_USER';     Label='ชื่อผู้ใช้แดชบอร์ด';          Secret=$false}
    @{Key='DASHBOARD_PASS';     Label='รหัสผ่านแดชบอร์ด';            Secret=$true }
    @{Key='DASHBOARD_PIN';      Label='PIN แอดมิน (6 หลัก)';         Secret=$true }
    @{Key='SUMMARY_CHAT_ID';    Label='Chat ID สรุปยอด';            Secret=$false}
    @{Key='ALLOWED_CHAT_IDS';   Label='Chat ID ที่อนุญาต (คั่น ,)'; Secret=$false}
  )

  function Read-EnvFile([string]$p) {
    $m = @{}
    if (Test-Path $p) {
      foreach ($ln in (Get-Content $p -Encoding UTF8)) {
        if ($ln -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') {
          $v = $Matches[2].Trim()
          if ($v.Length -ge 2 -and $v[0] -eq '"' -and $v[$v.Length-1] -eq '"') { $v = $v.Substring(1, $v.Length-2) }
          $m[$Matches[1]] = $v
        }
      }
    }
    return $m
  }
  $cur = Read-EnvFile $envPath

  function Mask([string]$v) {
    if ([string]::IsNullOrEmpty($v)) { return '(ว่าง)' }
    if ($v.Length -le 4) { return '****' }
    return ('*' * 6) + $v.Substring($v.Length - 4)
  }

  while ($true) {
    Write-Host ""
    Write-Host "========= เมนูตั้งค่า Slip Bot =========" -ForegroundColor Cyan
    for ($i = 0; $i -lt $Fields.Count; $i++) {
      $f = $Fields[$i]; $val = $cur[$f.Key]
      $disp = if ($f.Secret) { Mask $val } elseif ([string]::IsNullOrEmpty($val)) { '(ว่าง)' } else { $val }
      Write-Host ("  {0,2}) {1,-26} : {2}" -f ($i + 1), $f.Label, $disp)
    }
    Write-Host "   P) ดึงค่าทั้งหมดจาก Vercel (login บัญชีเดิม)" -ForegroundColor Magenta
    Write-Host "   S) บันทึก + deploy (รันบอท)" -ForegroundColor Green
    Write-Host "   Q) ออก (ไม่ deploy)"          -ForegroundColor DarkGray
    $choice = Read-Host "เลือกหมายเลขที่จะแก้ (หรือ P / S / Q)"

    if ($choice -match '^[Ss]$') { break }
    if ($choice -match '^[Qq]$') { Write-Host "ยกเลิก — ไม่ได้ deploy" -ForegroundColor DarkGray; return $false }
    if ($choice -match '^[Pp]$') { Sync-VercelEnv -Dir $Dir -EnvPath $envPath; $cur = Read-EnvFile $envPath; continue }

    $n = 0
    if ([int]::TryParse($choice, [ref]$n) -and $n -ge 1 -and $n -le $Fields.Count) {
      $f = $Fields[$n - 1]
      if ($f.Secret) {
        $sec  = Read-Host "  ใส่ค่าใหม่ '$($f.Label)' (พิมพ์แล้วไม่โชว์)" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      } else {
        $plain = Read-Host "  ใส่ค่าใหม่ '$($f.Label)'"
      }
      if (-not [string]::IsNullOrEmpty($plain)) { $cur[$f.Key] = $plain }
    } else {
      Write-Host "  เลือกไม่ถูกต้อง ลองใหม่" -ForegroundColor Yellow
    }
  }

  # เขียนกลับ .env: อัปเดตเฉพาะ key ที่จัดการ คงบรรทัด/คอมเมนต์อื่นไว้
  $lines   = @(Get-Content $envPath -Encoding UTF8)
  $managed = $Fields | ForEach-Object { $_.Key }
  $seen    = @{}
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*([A-Za-z0-9_]+)\s*=') {
      $k = $Matches[1]
      if ($managed -contains $k) { $lines[$i] = '{0}="{1}"' -f $k, $cur[$k]; $seen[$k] = $true }
    }
  }
  foreach ($k in $managed) {
    if (-not $seen[$k] -and -not [string]::IsNullOrEmpty($cur[$k])) { $lines += ('{0}="{1}"' -f $k, $cur[$k]) }
  }
  $content = ($lines -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($envPath, $content, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "[OK] บันทึกลง .env แล้ว (key ถูกซ่อนในเครื่อง ไม่ขึ้น git)" -ForegroundColor Green
  return $true
}

function Invoke-SlipDeploy {
  param([string]$Dir = (Get-Location).Path)
  Push-Location $Dir
  Write-Host "[deploy] รันบอทในเครื่อง (PM2) ..." -ForegroundColor Cyan
  $running = ''
  try { $running = (npx pm2 jlist | Out-String) } catch { $running = '' }
  if ($running -match 'slip-bot') { npx pm2 restart slip-bot --update-env } else { npx pm2 start ecosystem.config.js }
  npx pm2 save
  Pop-Location
  Write-Host "เสร็จแล้ว! แดชบอร์ด: http://localhost:3000" -ForegroundColor Green
}

# รันไฟล์นี้ตรงๆ (ไม่ได้ถูก dot-source) -> เปิดเมนู แล้ว deploy local
if ($MyInvocation.InvocationName -ne '.') {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
  if (Invoke-SlipSettings -Dir $here) { Invoke-SlipDeploy -Dir $here }
}
