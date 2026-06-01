const { google } = require('googleapis');
const fs = require('fs');

try {
  const credentials = JSON.parse(fs.readFileSync('./tokens/google_token.json', 'utf8'));
  console.log("Read credentials:", credentials);
  const client = google.auth.fromJSON(credentials);
  console.log("Client created successfully!");
} catch (e) {
  console.error("Error creating client:", e.message);
}
