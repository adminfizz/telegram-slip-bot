// อัปเดต/เพิ่มค่าใน .env แบบปลอดภัย: node scripts/set_env.js KEY VALUE
const fs = require('fs');
const path = require('path');
const key = process.argv[2];
const value = process.argv[3] || '';
const p = path.join(__dirname, '..', '.env');
let c = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
const re = new RegExp('^' + key + '=.*$', 'm');
const line = key + '="' + value + '"';
if (re.test(c)) c = c.replace(re, line);
else c = c.replace(/\s*$/, '') + '\n' + line + '\n';
fs.writeFileSync(p, c, 'utf8');
console.log(key + ' set (' + value.length + ' chars)');
