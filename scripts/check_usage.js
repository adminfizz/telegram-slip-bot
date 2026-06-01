require('dotenv').config();
const { authorize } = require('../src/auth');
const { getSystemState, formatDashboardSystemState } = require('../src/sheets');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const s = formatDashboardSystemState(await getSystemState(auth, ssid));
  console.log('Dashboard usage → tokens:', s.usage.totalTokens, '| count(รูป):', s.usage.count);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
