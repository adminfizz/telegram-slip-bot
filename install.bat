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

REM --- 4) ตรวจไฟล์ลับที่ต้องคัดลอกมาจากเครื่องหลัก ---
echo.
echo [3/5] ตรวจไฟล์ตั้งค่า/ความลับ...
set MISSING=0
if not exist ".env" ( echo   [!] ขาด .env  ^(คัดลอกจากเครื่องหลักมาวางในโฟลเดอร์นี้^) & set MISSING=1 )
if not exist "credentials.json" ( echo   [!] ขาด credentials.json & set MISSING=1 )
if not exist "tokens\google_token.json" ( echo   [!] ขาด tokens\google_token.json ^(Google OAuth token^) & set MISSING=1 )
if "%MISSING%"=="1" (
  echo.
  echo   *** ยังขาดไฟล์ลับ — คัดลอกจากเครื่องหลักมาก่อน แล้วรัน install.bat ใหม่ ***
  echo   ดูรายละเอียดใน SETUP.md
  echo.
  pause
  exit /b 1
)
echo   [OK] ไฟล์ลับครบ

REM --- 5) เริ่มบอทด้วย PM2 + บันทึก list ---
echo.
echo [4/5] เริ่มบอทด้วย PM2...
call npx pm2 start ecosystem.config.js
call npx pm2 save
echo.
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
