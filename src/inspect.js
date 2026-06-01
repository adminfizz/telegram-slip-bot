const { google } = require('googleapis');
const { authorize } = require('./auth');

async function checkSheets() {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = '1JE4Xlk1R7mOqs1NWfPMCegg7YAESglwutunEIHQFyas';
  
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  for (const sheet of res.data.sheets) {
    const title = sheet.properties.title;
    console.log(`\n--- Sheet: ${title} ---`);
    const data = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${title}'!A1:E5` });
    console.log(data.data.values);
  }
}

checkSheets().catch(console.error);
