@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ติดตั้ง Slip Bot
echo ============================================
echo    ติดตั้ง Slip Bot (telegram-slip-bot)
echo ============================================
echo.

REM --- 1) ตรวจ Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo [X] ยังไม่มี Node.js บนเครื่องนี้
  echo     กรุณาติดตั้ง Node.js 20+ ก่อนที่ https://nodejs.org แล้วรันไฟล์นี้ใหม่
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v

REM --- 2) ติดตั้ง dependencies ---
echo.
echo [1/5] กำลังติดตั้ง dependencies (npm install)...
call npm install
if errorlevel 1 ( echo [X] npm install ล้มเหลว & pause & exit /b 1 )

REM --- 3) ตรวจ PM2 ---
echo.
echo [2/5] ตรวจ PM2...
call npx pm2 -v >nul 2>nul
if errorlevel 1 (
  echo     ติดตั้ง PM2...
  call npm install -g pm2
)

REM --- 4) เปิดเมนูตั้งค่า (เขียน .env ในเครื่อง) + ดึงค่าจาก Vercel ได้ + deploy local ---
echo.
echo [3/5] เปิดเมนูตั้งค่า...
echo   (เลือก P เพื่อดึง key ทั้งหมดจาก Vercel บัญชีเดิม หรือกรอกเอง แล้ว S เพื่อบันทึก+รัน)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0settings.ps1"
echo.

REM --- 5) เสร็จ ---
echo [5/5] เสร็จแล้ว!
echo.
echo   - ดูสถานะ:  npx pm2 status
echo   - ดู log:   npx pm2 logs slip-bot
echo   - หยุด:     npx pm2 stop slip-bot
echo   - แดชบอร์ด: http://localhost:3000
echo.
echo   *** สำคัญ: อย่ารันบอทพร้อมกัน 2 เครื่องด้วย token เดียวกัน ***
echo       (Telegram ยอมให้ poll ได้ทีละเครื่อง — เครื่องสำรองเปิดเฉพาะตอนเครื่องหลักดับ)
echo.
echo   อยากให้สตาร์ทอัตโนมัติหลังรีบูต: รัน  npx pm2 startup  (ครั้งเดียว, ต้อง Admin)
echo.
pause
