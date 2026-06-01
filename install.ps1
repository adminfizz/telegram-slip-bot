# =====================================================
#  Slip Bot — pull-based installer (PowerShell)
#  ติดตั้ง/อัปเดตบรรทัดเดียว:
#    irm https://raw.githubusercontent.com/adminfizz/telegram-slip-bot/master/install.ps1 | iex
#  มีโค้ดอยู่แล้ว -> git pull อัปเดต | ยังไม่มี -> git clone ให้อัตโนมัติ
# =====================================================
$ErrorActionPreference = 'Stop'
$Repo = 'https://github.com/adminfizz/telegram-slip-bot.git'
$Dir  = if ($env:SLIPBOT_DIR) { $env:SLIPBOT_DIR } else { 'C:\ANto' }

Write-Host "==================================" -ForegroundColor Cyan
Write-Host "   ติดตั้ง Slip Bot (telegram-slip-bot)" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan

# 1) ตรวจ Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[X] ไม่พบ Node.js — ติดตั้ง Node 20+ จาก https://nodejs.org แล้วรันใหม่" -ForegroundColor Red
  return
}
Write-Host "[OK] Node.js $(node -v)"

# 2) ตรวจ git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "[X] ไม่พบ git — ติดตั้งจาก https://git-scm.com แล้วรันใหม่" -ForegroundColor Red
  return
}

# 3) clone หรือ pull
if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "[1/5] อัปเดตโค้ด (git pull) ..."
  git -C $Dir pull --ff-only
} else {
  Write-Host "[1/5] ดึงโค้ดลงเครื่อง (git clone) -> $Dir ..."
  git clone $Repo $Dir
}
Set-Location $Dir

# 4) ติดตั้ง dependencies
Write-Host "[2/5] npm install ..."
npm install

# 5) ตรวจ/ติดตั้ง PM2
Write-Host "[3/5] ตรวจ PM2 ..."
$pm2ok = $false
try { $null = npx pm2 -v; $pm2ok = $? } catch { $pm2ok = $false }
if (-not $pm2ok) { Write-Host "    ติดตั้ง PM2 ..."; npm install -g pm2 }

# 6) เปิดเมนูตั้งค่า (เขียน .env ในเครื่อง — ไม่ใช่บนเว็บ; มีปุ่มดึงค่าทั้งหมดจาก Vercel)
Write-Host "[4/5] เปิดเมนูตั้งค่า ..."
# โหลดฟังก์ชันจาก settings.ps1 แบบเลี่ยง ExecutionPolicy (อ่านเนื้อไฟล์มา dot-source)
. ([scriptblock]::Create((Get-Content (Join-Path $Dir 'settings.ps1') -Raw -Encoding UTF8)))
$ok = Invoke-SlipSettings -Dir $Dir

# เตือนไฟล์ Google ที่ต้องคัดลอกเอง (ถ้าไม่ได้ดึง JSON ผ่าน .env)
foreach ($f in @('credentials.json','tokens\google_token.json')) {
  if (-not (Test-Path (Join-Path $Dir $f))) {
    Write-Host "  [!] ยังไม่มี $f — คัดลอกจากเครื่องหลักมาวาง (จำเป็นต่อ Google Sheets)" -ForegroundColor Yellow
  }
}

# 7) deploy local
if ($ok) {
  Write-Host "[5/5] deploy (รันบอทในเครื่อง) ..."
  Invoke-SlipDeploy -Dir $Dir
} else {
  Write-Host "[5/5] ข้ามการ deploy (ออกจากเมนูตั้งค่า)" -ForegroundColor DarkGray
}
Write-Host "  *** อย่ารันบอท 2 เครื่องพร้อมกันด้วย token เดียวกัน (Telegram 409) ***" -ForegroundColor Yellow
