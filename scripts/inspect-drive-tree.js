require('dotenv').config();

const { google } = require('googleapis');
const { authorize } = require('../src/auth');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function listChildren(drive, parentId, depth = 0) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and trashed=false`,
    fields: 'files(id, name, mimeType)',
    spaces: 'drive',
    orderBy: 'folder,name',
  });

  for (const item of res.data.files || []) {
    const isFolder = item.mimeType === FOLDER_MIME;
    console.log(`${'  '.repeat(depth)}- ${item.name}${isFolder ? '/' : ''}`);
    if (isFolder) {
      await listChildren(drive, item.id, depth + 1);
    }
  }
}

async function main() {
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const rootRes = await drive.files.list({
    q: `name='TelegramSlipBot' and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id, name, mimeType)',
    spaces: 'drive',
  });

  const roots = rootRes.data.files || [];
  if (roots.length === 0) {
    console.log('TelegramSlipBot folder not found.');
    return;
  }

  for (const root of roots) {
    console.log(`- ${root.name}/`);
    await listChildren(drive, root.id, 1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
