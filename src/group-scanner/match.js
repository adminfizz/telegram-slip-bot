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
  const matched = [], missingSlip = [];
  for (const g of groups) {
    const lst = idxByKey.get(g.amount + '|' + g.last4) || [];
    let hit = -1;
    while (lst.length) { const i = lst.shift(); if (!used[i]) { hit = i; break; } }
    if (hit >= 0) { used[hit] = true; matched.push({ group: g, slip: slips[hit] }); }
    else missingSlip.push(g);
  }
  const extraSlip = slips.filter((s, i) => !used[i]);
  return { matched, missingSlip, extraSlip };
}
module.exports = { matchGroupSlips };
