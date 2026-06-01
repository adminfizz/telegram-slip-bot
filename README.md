# 🤖 Telegram Slip Bot

บอท Telegram สำหรับอ่านสลิปธนาคารและ ATM อัตโนมัติ โดยจับเลข 4 ตัวท้ายของบัญชี แล้วนำไปบันทึกแยกแท็บใน Google Sheets ให้ทันที

## 📌 ฟีเจอร์หลัก
- รองรับ **สลิปดิจิทัล** และ **สลิป ATM (กระดาษความร้อน)**
- แยกบันทึกยอด **โอนเงิน**, **ถอนเงิน (ATM)**, **ชำระบิล** 
- สร้างแท็บ (Tab) ใน Google Sheets ตามเลข 4 ตัวท้ายของบัญชีให้อัตโนมัติ
- ป้องกันการบันทึกสลิปซ้ำ (Duplicate detection)
- สำรองรูปภาพสลิปเก็บไว้ใน Google Drive โดยแยกตามวัน/เดือน
- มีคำสั่ง `/report` สรุปยอดโอนและยอดกดเงิน ทั้งแบบรวมทุกบัญชีและแยกแต่ละบัญชี

---

## 🚀 วิธีติดตั้งและใช้งาน

### สิ่งที่ต้องเตรียม
1. **Node.js** - ไปที่ [nodejs.org](https://nodejs.org/) เพื่อดาวน์โหลดและติดตั้ง
2. **Telegram Bot Token** - ขอจาก [@BotFather](https://t.me/botfather)
3. **Gemini API Key** - ขอจาก [Google AI Studio](https://aistudio.google.com/)
4. **Google Cloud Credentials** 
   - สร้างโปรเจกต์ที่ [Google Cloud Console](https://console.cloud.google.com/)
   - เปิดใช้งาน **Google Sheets API** และ **Google Drive API**
   - สร้างข้อมูลรับรอง (Credentials) แบบ **OAuth 2.0 Client ID (Desktop App)**
   - ดาวน์โหลดไฟล์ JSON เปลี่ยนชื่อเป็น `credentials.json` และนำมาวางในโฟลเดอร์โปรเจกต์ (`c:\ANto\`)

### ขั้นตอนการรัน
1. เปิด Command Prompt หรือ PowerShell แล้วเข้าไปที่โฟลเดอร์โปรเจกต์
   ```bash
   cd c:\ANto
   ```
2. ติดตั้ง Dependencies (Packages)
   ```bash
   npm install
   ```
3. ตั้งค่าไฟล์ `.env`
   เปิดไฟล์ `.env` ขึ้นมาและใส่ Token / API Key ให้ครบ:
   ```env
   TELEGRAM_BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"
   GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
   ```
4. รันบอท
   ```bash
   npm start
   ```
5. **(สำคัญมากในครั้งแรก)** เมื่อรันครั้งแรก จะมีหน้าเว็บเปิดขึ้นมาให้คุณ Login บัญชี Google (เพื่ออนุญาตให้บอทเข้าถึง Sheets และ Drive ของคุณ) กดยอมรับสิทธิ์ หลังจากนั้นบอทจะบันทึก Token ไว้ และไม่ต้อง Login อีก

---

## 💬 คำสั่งที่ใช้ได้ใน Telegram

- 📷 **ส่งรูปสลิป** — บอทจะวิเคราะห์และบันทึกข้อมูลทันที
- `/report` — ดูยอดสรุปการโอนเงิน/กดเงิน/ชำระบิล ของทุกบัญชี
- `/report 4321` — ดูรายงานละเอียดเฉพาะบัญชี (ระบุเลข 4 ตัวท้าย)

> **หมายเหตุ:** โปรเจกต์นี้ไม่ได้เก็บข้อมูล **"สถานที่/สาขาในสลิป"** ไว้ตามความต้องการ เพื่อความเป็นส่วนตัวสูงสุด
