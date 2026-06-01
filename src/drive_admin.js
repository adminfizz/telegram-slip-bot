const { google } = require('googleapis');
const { clearFolderCache } = require('./drive');

// ─── List files in a Drive folder ─────────────────────────────────────────────
async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      spaces: 'drive',
      pageToken: pageToken || undefined,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function deleteFolderContents(drive, folderId, deleteFolders = false) {
  let deletedCount = 0;
  const items = await listFilesInFolder(drive, folderId);

  for (const item of items) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      deletedCount += await deleteFolderContents(drive, item.id, deleteFolders);
      if (deleteFolders) {
        await drive.files.delete({ fileId: item.id });
      }
    } else {
      await drive.files.delete({ fileId: item.id });
      deletedCount++;
    }
  }

  return deletedCount;
}

// ─── Delete Drive files for a specific account (slip_LAST4_*) ────────────────
async function deleteDriveFilesForAccount(auth, last4) {
  const drive = google.drive({ version: 'v3', auth });
  let deletedCount = 0;
  try {
    // Find all files whose name starts with slip_LAST4_
    let pageToken = null;
    do {
      const res = await drive.files.list({
        q: `name contains 'slip_${last4}_' and trashed=false`,
        fields: 'nextPageToken, files(id, name)',
        spaces: 'drive',
        pageToken: pageToken || undefined,
      });
      for (const file of res.data.files || []) {
        await drive.files.delete({ fileId: file.id });
        deletedCount++;
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.error(`Drive delete error (${last4}):`, err.message);
  }
  return deletedCount;
}

// ─── Delete ALL Drive files in TelegramSlipBot folder ────────────────────────
async function deleteAllDriveFiles(auth) {
  const drive = google.drive({ version: 'v3', auth });
  let deletedCount = 0;
  try {
    // Find root folder
    const rootRes = await drive.files.list({
      q: `name='TelegramSlipBot' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });
    if (!rootRes.data.files || rootRes.data.files.length === 0) return 0;

    const rootId = rootRes.data.files[0].id;
    deletedCount = await deleteFolderContents(drive, rootId, true);
    clearFolderCache(); // โฟลเดอร์ถูกลบแล้ว → ล้าง cache กันชี้ ID เก่า
  } catch (err) {
    console.error('Drive deleteAll error:', err.message);
  }
  return deletedCount;
}

module.exports = { deleteDriveFilesForAccount, deleteAllDriveFiles };
