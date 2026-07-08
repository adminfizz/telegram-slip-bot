// login.js — login Telegram user account ครั้งเดียว เพื่อได้ "session string" (เก็บใน .env)
// รันแบบ interactive: node src/group-scanner/login.js  → กรอก OTP ที่ Telegram ส่งมา
// ต้องมี: npm i telegram input   + ตั้ง TG_API_ID / TG_API_HASH ใน .env (ขอจาก https://my.telegram.org)
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input'); // prompt ใน terminal

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

(async () => {
  if (!apiId || !apiHash) {
    console.error('❌ ต้องตั้ง TG_API_ID และ TG_API_HASH ใน .env ก่อน (ขอจาก https://my.telegram.org → API development tools)');
    process.exit(1);
  }
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => await input.text('เบอร์โทร (เช่น +66812345678): '),
    password: async () => await input.text('รหัส 2FA (ถ้ามี ไม่มีก็ Enter): '),
    phoneCode: async () => await input.text('OTP ที่ Telegram ส่งมา: '),
    onError: (err) => console.error(err),
  });
  console.log('\n✅ login สำเร็จ — เก็บบรรทัดนี้ลง .env เป็น TG_SESSION=\n');
  console.log(client.session.save());
  console.log('\n(อย่าเผยแพร่ session string นี้ — เท่ากับรหัสเข้าบัญชี Telegram)');
  await client.disconnect();
  process.exit(0);
})();
