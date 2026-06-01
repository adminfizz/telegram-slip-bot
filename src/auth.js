const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const path = require('path');
const { google } = require('googleapis');

const SCOPES     = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];
const TOKEN_PATH = path.join(process.cwd(), 'tokens', 'google_token.json');
const CRED_PATH  = path.join(process.cwd(), 'credentials.json');

// Shared promise for dashboard-based OAuth callback
let _pendingResolve = null;
let _pendingReject  = null;

function resolvePendingOAuth(code) {
  if (_pendingResolve) { _pendingResolve(code); _pendingResolve = null; _pendingReject = null; }
}
function rejectPendingOAuth(err) {
  if (_pendingReject) { _pendingReject(err); _pendingResolve = null; _pendingReject = null; }
}

// ─── Load saved token ────────────────────────────────────────────────────────
async function loadSavedCredentialsIfExist() {
  try {
    const raw   = process.env.GOOGLE_TOKEN_JSON || await fs.readFile(TOKEN_PATH, 'utf-8');
    const saved = JSON.parse(raw);
    if (!saved.refresh_token) {
      console.warn('⚠️ Token ไม่มี refresh_token — ต้อง Authorize ใหม่');
      return null;
    }
    const keys   = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || await fs.readFile(CRED_PATH, 'utf-8'));
    const key    = keys.installed || keys.web;
    const client = new google.auth.OAuth2(key.client_id, key.client_secret);
    client.setCredentials(saved);
    return client;
  } catch (_) { return null; }
}

// ─── Save token ───────────────────────────────────────────────────────────────
async function saveCredentials(client) {
  const keys = JSON.parse(await fs.readFile(CRED_PATH, 'utf-8'));
  const key  = keys.installed || keys.web;
  await fs.writeFile(TOKEN_PATH, JSON.stringify({
    type:          'authorized_user',
    client_id:     key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  }, null, 2));
}

// ─── Find a free port ────────────────────────────────────────────────────────
function findFreePort(start = 3001) {
  return new Promise(resolve => {
    const tryPort = (p) => {
      const s = http.createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

// ─── Desktop app OAuth (opens local callback server on free port) ─────────────
async function doDesktopOAuth(key) {
  const port        = await findFreePort(3001);
  const redirectUri = `http://localhost:${port}/oauth2callback`;
  const client      = new google.auth.OAuth2(key.client_id, key.client_secret, redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       SCOPES,
  });

  console.log('\n🔐 กรุณาเปิด URL นี้ในเบราว์เซอร์เพื่อ Authorize (ครั้งเดียว):');
  console.log(authUrl + '\n');
  console.log('💡 หลังจากนี้ระบบ auto-start ทุกครั้ง ไม่ต้องทำซ้ำอีก!');

  try { const o = await import('open'); await o.default(authUrl); } catch (_) {}

  // Start local callback server
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url  = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const err  = url.searchParams.get('error');
      if (err) {
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#e0e0e0"><h2>❌ ยกเลิกแล้ว</h2></body></html>');
        server.close();
        return reject(new Error('User denied access'));
      }
      if (code) {
        res.end(`
          <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f3460;color:#e0e0e0">
            <div style="max-width:480px;margin:auto;background:#16213e;padding:40px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.4)">
              <div style="font-size:64px;margin-bottom:16px">✅</div>
              <h2 style="color:#4ade80;margin:0 0 12px">Authorize สำเร็จ!</h2>
              <p style="color:#94a3b8">Bot กำลังเริ่มทำงาน...</p>
              <p style="color:#64748b;font-size:13px;margin-top:24px">ปิดหน้าต่างนี้ได้เลยครับ</p>
            </div>
          </body></html>
        `);
        server.close();
        return resolve(code);
      }
      res.end('Not found');
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`🎧 รอรับ OAuth callback บน port ${port}...`);
    });

    server.on('error', reject);
    // 10-minute timeout
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout')); }, 10 * 60 * 1000);
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  if (!tokens.refresh_token) {
    throw new Error('ไม่ได้รับ refresh_token — ลอง revoke access ที่ myaccount.google.com/permissions แล้วลองใหม่');
  }

  return client;
}

// ─── Web app OAuth (uses dashboard /oauth2callback route) ────────────────────
async function doWebOAuth(key) {
  const redirectUri = 'http://localhost:3000/oauth2callback';
  const client      = new google.auth.OAuth2(key.client_id, key.client_secret, redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       SCOPES,
  });

  console.log('\n🔐 กรุณาเปิด URL นี้ในเบราว์เซอร์เพื่อ Authorize (ครั้งเดียว):');
  console.log(authUrl + '\n');

  try { const o = await import('open'); await o.default(authUrl); } catch (_) {}

  const code = await new Promise((resolve, reject) => {
    _pendingResolve = resolve;
    _pendingReject  = reject;
    setTimeout(() => reject(new Error('OAuth timeout')), 10 * 60 * 1000);
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  return client;
}

// ─── Main authorize function ──────────────────────────────────────────────────
async function authorize() {
  // Try saved token first
  const saved = await loadSavedCredentialsIfExist();
  if (saved) return saved;

  // Load credentials.json
  try { await fs.access(CRED_PATH); }
  catch { throw new Error('credentials.json not found — กรุณาอัปโหลดผ่าน Dashboard'); }

  const keys    = JSON.parse(await fs.readFile(CRED_PATH, 'utf-8'));
  const isDesktop = !!keys.installed; // Desktop app = "installed", Web app = "web"
  const key     = keys.installed || keys.web;

  let client;
  if (isDesktop) {
    // Desktop app: open local server on any free port (no registration needed)
    client = await doDesktopOAuth(key);
  } else {
    // Web app: use dashboard's /oauth2callback route (must be registered)
    client = await doWebOAuth(key);
  }

  await saveCredentials(client);
  console.log('✅ บันทึก Token สำเร็จ! ครั้งต่อไป Bot จะ auto-start ทันที ไม่ต้องทำซ้ำ!');
  return client;
}

module.exports = { authorize, resolvePendingOAuth, rejectPendingOAuth };
