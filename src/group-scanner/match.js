// match.js — จับคู่ประกาศกลุ่ม ↔ สลิป OCR แบบ 1:1 multiset (ไม่ยุบซ้ำ)
// key = ยอด|เลข4ตัวท้าย ; เทียบ last4 ประกาศ กับ recipient_last4 (บัญชีผู้รับ) ของสลิปเท่านั้น
// (เงินโอนถึงลูกค้า — ยืนยันแล้วว่า last4 ต้นทางของสลิปไม่เคยตรงประกาศ; การ key ด้วย last4 ต้นทางด้วย
//  ทำให้สลิปอยู่ 2 bucket → greedy strand match ผิด. จับด้วยผู้รับอย่างเดียว = ตรง domain + 1 slip อยู่ 1 bucket)
// groups: [{amount,last4,date,...}] · slips: [{amount,recipient_last4,day,...}]
function matchGroupSlips(groups, slips) {
  const used = new Array(slips.length).fill(false);
  const idxByKey = new Map();
  slips.forEach((s, i) => {
    const acc = s.recipient_last4; // สลิปถอน ATM ไม่มีผู้รับ → ไม่เข้า bucket → ไม่จับกับประกาศ (ถูกต้อง)
    if (!acc) return;
    const k = s.amount + '|' + acc;
    if (!idxByKey.has(k)) idxByKey.set(k, []);
    idxByKey.get(k).push(i);
  });
  // วันเป็นตัวเลข (คืน null ถ้าแปลงไม่ได้ — ไม่ปน epoch 0 ที่ทำ sort/proximity เพี้ยน)
  const dnum = d => { const t = Date.parse(String(d || '').slice(0, 10)); return isNaN(t) ? null : t / 86400000; };
  // จับคู่ตามลำดับวันของประกาศ (วันเสียไปท้าย); แต่ละประกาศเลือกสลิปยอด+ผู้รับตรง "วันใกล้ที่สุด" ที่ยังไม่ถูกใช้
  // → 2 ประกาศยอดเดียวกันคนละวัน จับสลิปคนละใบถูกวัน (1:1 ไม่ยุบซ้ำ)
  const ordered = [...groups].sort((a, b) => {
    const da = dnum(a.date), db = dnum(b.date);
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  });
  const matched = [], missingSlip = [];
  for (const g of ordered) {
    const lst = idxByKey.get(g.amount + '|' + g.last4) || [];
    const gd = dnum(g.date);
    let best = -1, bestDiff = Infinity;
    for (const i of lst) {
      if (used[i]) continue;
      const sd = dnum(slips[i].day);
      // ถ้าวันฝั่งใดฝั่งหนึ่งเสีย → ถือ diff = 0 (เลือกตัวแรกที่ว่าง ไม่ลงโทษด้วยระยะปลอม)
      const diff = (gd == null || sd == null) ? 0 : Math.abs(sd - gd);
      if (diff < bestDiff) { bestDiff = diff; best = i; if (diff === 0) break; }
    }
    if (best >= 0) { used[best] = true; matched.push({ group: g, slip: slips[best], dayDiff: bestDiff }); }
    else missingSlip.push(g);
  }
  const extraSlip = slips.filter((s, i) => !used[i]);
  return { matched, missingSlip, extraSlip };
}
module.exports = { matchGroupSlips };
