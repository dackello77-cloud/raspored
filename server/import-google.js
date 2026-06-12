const process = require('node:process');

const cloudUrl = process.argv[2];
const username = process.argv[3] || 'admin';
const localUrl = process.argv[4] || 'http://127.0.0.1:8787/api';

if (!cloudUrl) {
  console.error(
    'Upotreba: node import-google.js GOOGLE_EXEC_URL [admin_user] [local_api_url]'
  );
  process.exit(1);
}

async function cloudCall(action, args) {
  const callback = '__importCallback';
  const url = new URL(cloudUrl);
  url.searchParams.set('action', action);
  url.searchParams.set('payload', JSON.stringify(args));
  url.searchParams.set('callback', callback);
  url.searchParams.set('_', String(Date.now()));
  const response = await fetch(url);
  const text = await response.text();
  const prefix = `${callback}(`;
  if (!text.startsWith(prefix) || !text.endsWith(');')) {
    throw new Error(`Google API nije vratio očekivani odgovor za ${action}.`);
  }
  const parsed = JSON.parse(text.slice(prefix.length, -2));
  if (!parsed.ok) throw new Error(parsed.error || `Google akcija ${action} nije uspela.`);
  return parsed.data;
}

async function localCall(action, args) {
  const response = await fetch(localUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args })
  });
  const parsed = await response.json();
  if (!parsed.ok) throw new Error(parsed.error || `Lokalna akcija ${action} nije uspela.`);
  return parsed.data;
}

async function main() {
  console.log('Prijava na Google API...');
  const cloudLogin = await cloudCall('login', [username]);
  console.log('Preuzimanje podataka...');
  const exported = await cloudCall('exportData', [cloudLogin.token]);

  console.log('Prijava na lokalni API...');
  const localLogin = await localCall('login', ['admin']);
  console.log('Upis u SQLite...');
  const result = await localCall('importData', [localLogin.token, exported]);

  console.log(
    `Uvoz završen: ${result.usersImported} korisnika, ` +
    `${result.rowsImported} redova rasporeda.`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
