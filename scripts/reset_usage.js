require('dotenv').config();
const { authorize } = require('../src/auth');
const { getSystemState, setTokenUsage, formatDashboardSystemState } = require('../src/sheets');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;

  const before = formatDashboardSystemState(await getSystemState(auth, ssid)); // โหลด state ทั้งหมดเข้า cache
  console.log('BEFORE → tokens:', before.usage.totalTokens, '| count:', before.usage.count);

  await setTokenUsage(auth, ssid, 0, 0); // merge usage=0 ทับ (key อื่นคงเดิม)

  const after = formatDashboardSystemState(await getSystemState(auth, ssid));
  console.log('AFTER  → tokens:', after.usage.totalTokens, '| count:', after.usage.count);
  console.log(after.usage.totalTokens === 0 && after.usage.count === 0 ? '✅ รีเซ็ตสำเร็จ' : '❌ ยังไม่ 0');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
