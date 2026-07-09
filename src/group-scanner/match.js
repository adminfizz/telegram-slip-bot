// match.js — จับคู่ประกาศกลุ่ม ↔ สลิป OCR แบบ 1:1 multiset (ไม่ยุบซ้ำ)
// key = ยอด|เลข4ตัวท้าย ; เทียบ last4 ประกาศ กับทั้ง last4 และ recipient_last4 ของสลิป
// (เงินโอนถึงลูกค้า — เลขบัญชีในประกาศอาจตรงกับผู้รับหรือบัญชีหลักของสลิป)
// groups: [{amount,last4,...}] · slips: [{amount,last4,recipient_last4,...}]
function matchGroupSlips(groups, slips) {
  const used = new Array(slips.length).fill(false);
  const idxByKey = new Map();
  slips.forEach((s, i) => {
    for (const acc of new Set([s.last4, s.recipient_last4].filter(Boolean))) {
      const k = s.amount + '|' + acc;
      if (!idxByKey.has(k)) idxByKey.set(k, []);
      idxByKey.get(k).push(i);
    }
  });
  // จับคู่ตามลำดับวันของประกาศ; แต่ละประกาศเลือกสลิปยอด+บัญชีตรง "วันใกล้ที่สุด" ที่ยังไม่ถูกใช้
  // → 2 ประกาศยอดเดียวกันคนละวัน จับสลิปคนละใบถูกวัน (1:1 ไม่ยุบซ้ำ)
  const dnum = d => { const t = Date.parse(String(d || '').slice(0, 10)); return isNaN(t) ? 0 : t / 86400000; };
  const ordered = [...groups].sort((a, b) => dnum(a.date) - dnum(b.date));
  const matched = [], missingSlip = [];
  for (const g of ordered) {
    const lst = idxByKey.get(g.amount + '|' + g.last4) || [];
    const gd = dnum(g.date);
    let best = -1, bestDiff = Infinity;
    for (const i of lst) {
      if (used[i]) continue;
      const diff = Math.abs(dnum(slips[i].day) - gd);
      if (diff < bestDiff) { bestDiff = diff; best = i; if (diff === 0) break; }
    }
    if (best >= 0) { used[best] = true; matched.push({ group: g, slip: slips[best], dayDiff: bestDiff }); }
    else missingSlip.push(g);
  }
  const extraSlip = slips.filter((s, i) => !used[i]);
  return { matched, missingSlip, extraSlip };
}
module.exports = { matchGroupSlips };
