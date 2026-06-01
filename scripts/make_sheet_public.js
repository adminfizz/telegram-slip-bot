// ตั้งสิทธิ์ Google Sheet เป็น "anyone with link can view"
require('dotenv').config();
const { google } = require('googleapis');
const { authorize } = require('../src/auth');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  if (!ssid) { console.error('No SPREADSHEET_ID'); process.exit(1); }
  const drive = google.drive({ version: 'v3', auth });

  console.log('SPREADSHEET_ID:', ssid);
  try {
    const res = await drive.permissions.create({
      fileId: ssid,
      requestBody: { role: 'reader', type: 'anyone' },
      fields: 'id',
    });
    console.log('✅ Set permission (anyone with link → reader). permissionId:', res.data.id);
    console.log('🔗 View link: https://docs.google.com/spreadsheets/d/' + ssid + '/edit');
  } catch (e) {
    console.error('❌ Failed:', e.message);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
