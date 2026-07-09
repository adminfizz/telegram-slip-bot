// test-match.js — พิสูจน์การจับคู่ประกาศ↔สลิปด้วยข้อมูลจริง: node test-match.js [from] [to]
require('dotenv').config();
(async () => {
  const { authorize } = require('../auth');
  const { getGroupRecords } = require('./sheets-group');
  const { matchGroupSlips } = require('./match');
  const { listTransactions } = require('../sheets');
  const auth = await authorize(); const sid = process.env.SPREADSHEET_ID;
  const from = process.argv[2] || null, to = process.argv[3] || null;
  const norm = v => String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const inR = d => { const x = String(d || '').slice(0, 10); if (from && x < from) return false; if (to && x > to) return false; return true; };
  const gAll = await getGroupRecords(auth, sid, { from, to });
  const groups = gAll.filter(g => g.usable && g.amount != null && g.last4).map(g => ({ date: g.date, amount: r2(g.amount), last4: norm(g.last4), bank: g.bank, name: g.name }));
  const slipRaw = await listTransactions(auth, sid, { limit: 20000 });
  const slips = slipRaw.map(s => { const m = String(s.date || '').match(/^(\d{4}-\d{2}-\d{2})/); return { day: m ? m[1] : '', last4: norm(s.last4), recipient_last4: norm(s.recipient_last4), amount: r2(s.amount) }; }).filter(s => s.day && inR(s.day));
  const { matched, missingSlip, extraSlip } = matchGroupSlips(groups, slips);
  console.log('RESULT ประกาศ=' + groups.length + ' สลิป=' + slips.length + ' | ตรง=' + matched.length + ' ขาดสลิป=' + missingSlip.length + ' เกินประกาศ=' + extraSlip.length);
  process.exit(0);
})();
