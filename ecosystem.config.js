module.exports = {
  apps: [{
    name: 'slip-bot',
    script: 'index.js',
    cwd: __dirname, // portable — ใช้โฟลเดอร์ที่ไฟล์นี้อยู่ (ย้ายไปเครื่องอื่นได้)
    instances: 1,
    exec_mode: 'fork', // fork (ไม่ใช่ cluster) — กัน Telegram poll ซ้อนจน 409 Conflict
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
