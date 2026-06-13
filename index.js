require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Create necessary directories
const tempDir = path.join(__dirname, 'temp');
const tokensDir = path.join(__dirname, 'tokens');

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(tokensDir)) fs.mkdirSync(tokensDir, { recursive: true });

// Start Dashboard (always runs)
const { createDashboard } = require('./src/dashboard/server');
const PORT = process.env.DASHBOARD_PORT || 3000;
// ปิด localtunnel: ใช้ Vercel เป็นทางเข้าสาธารณะแล้ว tunnel จึงซ้ำซ้อน + พ่น error connection refused รัวๆ
createDashboard(PORT, { localTunnel: false });

// Auto-open browser on local machine
(async () => {
  try {
    const open = (await import('open')).default;
    await open(`http://localhost:${PORT}`);
  } catch (_) {
    // open might fail in headless environments, ignore
  }
})();

console.log('🤖 Slip Bot Dashboard พร้อมใช้งาน!');
console.log('📌 เปิดหน้าตั้งค่าที่เบราว์เซอร์แล้วใส่ Token จากนั้นกดเริ่ม Bot ได้เลย');
