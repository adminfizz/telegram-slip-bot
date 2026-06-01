# 🚀 ติดตั้ง Slip Bot บนเครื่องใหม่ (เครื่องสำรอง)

## ⚡ วิธีที่ 1 — ติดตั้งบรรทัดเดียว (pull installer)
เปิด **PowerShell** บนเครื่องใหม่ แล้ววางคำสั่งนี้ (ต้องมี Node.js 20+ และ Git ก่อน):

```powershell
irm https://raw.githubusercontent.com/adminfizz/telegram-slip-bot/master/install.ps1 | iex
```

มันจะ: `git clone` (หรือ `git pull` ถ้ามีอยู่แล้ว) → `npm install` → ติดตั้ง PM2 → **เปิดเมนูตั้งค่า** → `deploy` รันบอทในเครื่องให้อัตโนมัติ

> โค้ดจะถูกดึงไปไว้ที่ `C:\ANto` (เปลี่ยนได้ด้วย `$env:SLIPBOT_DIR="D:\path"` ก่อนรัน)

## ⚡ วิธีที่ 2 — ดับเบิลคลิก
ถ้าก๊อปทั้งโฟลเดอร์มาแล้ว ดับเบิลคลิก **`install.bat`** ได้เลย (จะเปิดเมนูตั้งค่าให้เหมือนกัน)

---

## ⚙️ เมนูตั้งค่า (ไม่ต้องตั้งบนเว็บ)
หลังติดตั้ง เมนูจะเด้งขึ้นในหน้าต่าง CMD/PowerShell:

- กด **`P`** = **ดึง key/setting ทั้งหมดจาก Vercel** (login บัญชีเดิม) — ไม่ต้องพิมพ์เอง ✨
- กด **เลข 1–10** = แก้ค่าทีละช่อง (Token / API key / PIN ฯลฯ — ค่าลับพิมพ์แล้วไม่โชว์)
- กด **`S`** = บันทึกลง `.env` แล้ว **deploy** (รันบอท) ทันที
- กด **`Q`** = ออกโดยไม่รัน

> เปิดเมนูตั้งค่าใหม่ทีหลังได้ตลอด: `powershell -ExecutionPolicy Bypass -File settings.ps1`

### ไฟล์ Google (ถ้าไม่ได้ดึงผ่าน Vercel)
`vercel env pull` จะได้คีย์ทั้งหมดที่อยู่ใน env รวม `GOOGLE_CREDENTIALS_JSON`/`GOOGLE_TOKEN_JSON` ถ้ามีตั้งไว้
ถ้าใช้แบบไฟล์ ให้คัดลอกมาวางเอง: `credentials.json`, `tokens/google_token.json`

---

## คำสั่งที่ใช้บ่อย
```
npx pm2 status            # ดูสถานะ
npx pm2 logs slip-bot     # ดู log
npx pm2 restart slip-bot  # รีสตาร์ท
npx pm2 stop slip-bot     # หยุด
```
แดชบอร์ด: http://localhost:3000

## ⚠️ ข้อควรระวัง (สำคัญ)
- **ห้ามรันบอท 2 เครื่องพร้อมกันด้วย Telegram token เดียวกัน** — Telegram poll ได้ทีละเครื่อง ถ้าซ้อนจะขึ้น error 409 Conflict
- เครื่องสำรองให้**เปิดเฉพาะตอนเครื่องหลักดับ** (failover แบบสลับมือ): หยุดบอทเครื่องหลักก่อน → เริ่มเครื่องสำรอง
- ข้อมูลจริงอยู่บน Google Sheets อยู่แล้ว → เครื่องสำรองเชื่อม Sheets เดิม เห็นข้อมูลครบทันที
- `.env` ถูก gitignore ไว้ — key ไม่ขึ้น GitHub แน่นอน

## สตาร์ทอัตโนมัติหลังรีบูต (ไม่บังคับ)
```
npx pm2 startup     # ครั้งเดียว (รันใน PowerShell แบบ Admin)
npx pm2 save        # บันทึกรายการโปรเซสปัจจุบัน
```
