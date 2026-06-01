const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const ROOT_FOLDER_NAME = 'TelegramSlipBot';

// cache folder ID ในหน่วยความจำ (โฟลเดอร์ ปี/เดือน/วัน/บัญชี ซ้ำทุกสลิป) → ลด Drive list call
const _folderCache = new Map(); // key: `${parentId||'root'}/${name}` → folderId
function clearFolderCache() { _folderCache.clear(); }

async function getOrCreateFolder(drive, folderName, parentId = null) {
  const cacheKey = `${parentId || 'root'}/${folderName}`;
  if (_folderCache.has(cacheKey)) return _folderCache.get(cacheKey);

  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`;
  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  let id;
  if (res.data.files.length > 0) {
    id = res.data.files[0].id;
  } else {
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    };
    const folder = await drive.files.create({
      resource: fileMetadata,
      fields: 'id',
    });
    id = folder.data.id;
  }
  _folderCache.set(cacheKey, id);
  return id;
}

function getBangkokDateParts(dateText = null) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return {
      year: match[1],
      month: match[2],
      day: match[3],
    };
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const p = {};
  parts.forEach(pt => p[pt.type] = pt.value);
  return { year: p.year, month: p.month, day: p.day };
}

async function uploadSlip(auth, filePath, fileName, options = {}) {
  const drive = google.drive({ version: 'v3', auth });

  // Structure: TelegramSlipBot / YYYY-MM / YYYY-MM-DD / บัญชี_LAST4
  const dateParts = getBangkokDateParts(options.date);
  const fullDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const yearMonth = `${dateParts.year}-${dateParts.month}`;
  const accountFolderName = `บัญชี_${options.last4 || 'UNKNOWN'}`;

  try {
    const rootId = await getOrCreateFolder(drive, ROOT_FOLDER_NAME);
    const monthId = await getOrCreateFolder(drive, yearMonth, rootId);
    const dayId = await getOrCreateFolder(drive, fullDate, monthId);
    const accountId = await getOrCreateFolder(drive, accountFolderName, dayId);

    const fileMetadata = {
      name: fileName,
      parents: [accountId],
    };
    
    const media = {
      mimeType: 'image/jpeg',
      body: fs.createReadStream(filePath),
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink',
    });
    
    // Set permission to anyone with link can view, so it's viewable from the sheet
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    return file.data.webViewLink;
  } catch (error) {
    console.error('Error uploading to Drive:', error);
    return null;
  }
}

module.exports = { uploadSlip, getBangkokDateParts, clearFolderCache };
