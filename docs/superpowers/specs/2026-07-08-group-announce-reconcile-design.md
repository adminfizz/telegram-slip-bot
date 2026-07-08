# ระบบจับคู่ประกาศกลุ่ม Telegram ↔ สลิป OCR (group-announce-reconcile)

วันที่: 2026-07-08 · โปรเจค: telegram-slip-bot (slipv1) · สถานะ: approved, กำลังทำ P0

## เป้าหมาย
ดักข้อความ "ประกาศรายการ" ในกลุ่มแชท Telegram (ชื่อ/ธนาคาร/เลขบัญชี/จำนวนเงิน) แล้วจับคู่กับสลิปที่บอทเดิม OCR เก็บไว้ ว่าประกาศไหนมีสลิปตรง / ขาดสลิป / สลิปเกินประกาศ แสดงบนแดชบอร์ด slipv1 แท็บใหม่ + export Excel รองรับ scan ย้อนหลังตั้งแต่วันที่ 1 ของเดือน

## ข้อจำกัดสำคัญ (ทำไมต้อง user-client)
Telegram **Bot API อ่านประวัติแชทย้อนหลังไม่ได้** — บอทเห็นเฉพาะข้อความใหม่หลังออนไลน์ ไม่มี getChatHistory ใน Bot API → ต้องใช้ **MTProto user-client (gramjs)** ที่เรียก messages.getHistory ได้ ตัวเดียวทำได้ทั้ง backfill + real-time

## สถาปัตยกรรม
1. **Ingestion — `group-scanner` (gramjs user-client, PM2 process ใหม่)**
   - Telegram user session (api_id/api_hash + login OTP ครั้งเดียว → session string ใน .env)
   - โหมด backfill (getHistory ย้อนหลังตั้งแต่ date ที่กำหนด) + real-time (event handler)
   - กันซ้ำด้วย msg_id (+ index ของ record ในข้อความ)

2. **Parser — label-based, tolerant, multi-record** (`parser.js`)
   - label ยืดหยุ่น: ชื่อ/name, ธนาคาร/bank, เลขบัญชี/บัญชี, จำนวนเงิน/ยอด/เงิน, ยูสเซอร์/user, บ./บริษัท
   - รับ separator หลายแบบ (`:` `：` เว้นวรรค), ข้าม emoji/อักขระแปลก
   - 1 ข้อความ → หลาย record (flush เมื่อเจอ field ซ้ำ หรือจบ block)
   - เก็บ raw_text ทุกอัน; record ที่ไม่ครบ → สถานะ "รอตรวจ" ไม่ทิ้งเงียบ

3. **Storage — Google Sheets tab ใหม่ `_group`**
   - เหตุผล: Vercel dashboard อ่าน Sheets ตรงได้ (เหมือน slip data) → แท็บใหม่ทำงานบน slipv1.vercel.app ได้ทันที
   - fields: date, time, name, bank, account(+last4), amount, user, company, raw_text, msg_id, status

4. **Matching — multiset 1:1** (เหมือน bankmatch เดิม)
   - key = `amount | last4 | bank` (normalize ธนาคารไทย↔อังกฤษ; last4 เทียบทั้ง account_last4 และ recipient_last4 ของสลิป)
   - ต่อ key จับคู่ทีละใบ consume: ประกาศ N + สลิป M → matched=min(N,M), ประกาศขาดสลิป=max(0,N-M), สลิปเกินประกาศ=max(0,M-N)
   - **จับคู่ 1:1 ไม่ยุบซ้ำ** — ประกาศ 2 รายการเหมือนกันต้องมี 2 สลิป

5. **Dashboard — แท็บใหม่ใน slipv1 + Export Excel**
   - สไตล์เดียวกับ bankmatch: chips สรุป + 3 ลิสต์ (ตรง/ขาด/เกิน) + เลือกช่วงเวลา
   - ปุ่ม Export Excel: ทุกรายการพร้อมสถานะจับคู่

## เฟส
- **P0** ตั้ง gramjs + login + scan กลุ่มจริง + parser → โชว์ผล parse (ทำ parser + test ได้ก่อน โดยไม่ต้อง credentials)
- **P1** เขียนลง Sheets `_group` + backfill ตั้งแต่วันที่ 1
- **P2** matching engine + endpoint `/api/groupmatch`
- **P3** dashboard tab + export

## ต้องการจากเปอร์
- api_id + api_hash (my.telegram.org) + เบอร์ login (กด OTP เอง)
- กลุ่มเป้าหมาย (user account เป็นสมาชิกอยู่แล้ว)
- ตัวอย่างข้อความจริงเพิ่ม (หรือรอ scan เจอใน P0)

## เปิดค้าง / ต้องยืนยันตอนเจอข้อมูลจริง
- normalize ชื่อธนาคาร: ตาราง map ไทย↔อังกฤษ (กสิกรไทย→KBANK ฯลฯ) — เติมตามที่เจอจริง
- ช่วงเวลา match: ประกาศ vs สลิป เทียบทั้งเดือน หรือจำกัด ±วัน — เคาะตอน P2
- 1 ข้อความหลาย record: กติกา split ที่แน่นอน — ปรับตามตัวอย่างจริงใน P0
