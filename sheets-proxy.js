// Vercel serverless endpoint: /api/sheets
// Requires environment variables:
// - SERVICE_ACCOUNT_KEY : JSON string of service account key (private_key, client_email, etc.)
// - SPREADSHEET_ID : Google Sheets ID
// - SHEET_NAME : Sheet/tab name (e.g., 'words')
// - SESSION_SECRET : same as used in `api/session.js`

const crypto = require('crypto');

const SERVICE_ACCOUNT_KEY_JSON = process.env.SERVICE_ACCOUNT_KEY || null;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const SHEET_NAME = process.env.SHEET_NAME || 'words';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_to_secure_secret';

// cookie name used earlier
const SESSION_COOKIE_NAME = 'wb_session';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
}

// Convert zero-based column index to A1 column letter (0 -> A, 25 -> Z, 26 -> AA)
function columnLetter(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function signJwtRS256(unsigned, privateKey) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  sign.end();
  const sig = sign.sign(privateKey, 'base64');
  return sig.replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function createSignedJwtForServiceAccount(sa) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now()/1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const headerB64 = base64url(JSON.stringify(header));
  const claimB64 = base64url(JSON.stringify(claim));
  const unsigned = `${headerB64}.${claimB64}`;
  const signature = signJwtRS256(unsigned, sa.private_key);
  return `${unsigned}.${signature}`;
}

async function getAccessToken(sa) {
  const jwt = createSignedJwtForServiceAccount(sa);
  const params = new URLSearchParams();
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.append('assertion', jwt);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('token request failed: ' + res.status + ' ' + txt);
  }
  return res.json(); // { access_token, expires_in, token_type }
}

function verifySessionFromCookie(req) {
  try {
    const cookie = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(SESSION_COOKIE_NAME+'='));
    if (!cookie) return null;
    const token = cookie.split('=')[1];
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, bodyB64, sig] = parts;
    const data = `${headerB64}.${bodyB64}`;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
    const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload; // contains userId
  } catch (e) {
    console.warn('verifySession failed', e);
    return null;
  }
}

async function readSheetValues(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A:Z`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error('sheets read failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function appendRow(accessToken, row) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A:Z:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const body = { values: [row] };
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('sheets append failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function batchUpdateValues(accessToken, updates) {
  // updates: [{ range: 'Sheet!A2', values: [['val']] }, ...]
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`;
  const body = { valueInputOption: 'RAW', data: updates };
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('sheets batchUpdate failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function updateRow(accessToken, rowIndex, row) {
  // rowIndex is 1-based excluding header (so actual sheet row = rowIndex + 1)
  const sheetRow = rowIndex + 1; // header is row 1
  // compute end column from row length (supports up to many columns)
  const endCol = columnLetter(row.length - 1);
  const range = `${SHEET_NAME}!A${sheetRow}:${endCol}${sheetRow}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const body = { values: [row] };
  const res = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('sheets update failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

module.exports = async (req, res) => {
  try {
    if (!SERVICE_ACCOUNT_KEY_JSON) return res.status(500).json({ error: 'SERVICE_ACCOUNT_KEY not set' });
    const sa = typeof SERVICE_ACCOUNT_KEY_JSON === 'string' ? JSON.parse(SERVICE_ACCOUNT_KEY_JSON) : SERVICE_ACCOUNT_KEY_JSON;
    if (!sa || !sa.private_key) return res.status(500).json({ error: 'invalid service account key' });
    if (!SPREADSHEET_ID) return res.status(500).json({ error: 'SPREADSHEET_ID not set' });

    // verify session cookie
    const session = verifySessionFromCookie(req);
    if (!session || !session.userId) return res.status(401).json({ error: 'not_authenticated' });
    const userId = session.userId;

    // obtain access_token
    const tokenResp = await getAccessToken(sa);
    const accessToken = tokenResp.access_token;
    if (!accessToken) throw new Error('no access token');

    // parse action
    const body = req.method === 'GET' ? req.query : req.body || {};
    const action = body.action;
    if (!action) return res.status(400).json({ error: 'missing_action' });

    // Read current sheet values to get header row dynamically
    const sheetData = await readSheetValues(accessToken);
    const values = (sheetData.values || []);
    const hdr = values.length > 0 ? values[0].map(h => String(h || '').trim()) : [];
    // helper to locate user/word columns (fallback to 0/1)
    const userColIndex = hdr.findIndex(h => String(h || '').toLowerCase() === 'userid' || String(h || '').toLowerCase() === 'user' || String(h || '').toLowerCase() === 'email');
    const wordColIndex = hdr.findIndex(h => String(h || '').toLowerCase() === 'word');
    const effectiveUserCol = userColIndex >= 0 ? userColIndex : 0;
    const effectiveWordCol = wordColIndex >= 0 ? wordColIndex : 1;

    if (action === 'list') {
      if (values.length <= 1) return res.json([]);
      const rows = values.slice(1).map(r => {
        const obj = {};
        for (let i = 0; i < hdr.length; i++) obj[hdr[i] || ('col' + i)] = r[i] || '';
        return obj;
      });
      // filter by userId (case-insensitive)
      const filtered = rows.filter(r => (String(r[hdr[effectiveUserCol]] || '').trim().toLowerCase()) === String(userId || '').trim().toLowerCase());
      return res.json(filtered);
    }

    if (action === 'add') {
      const params = body;
      if (!params.word) return res.status(400).json({ error: 'missing word' });
      if (hdr.length === 0) return res.status(500).json({ error: 'empty_sheet_headers' });
      // Build row in sheet header order
      const row = hdr.map((h, idx) => {
        if (!h) return '';
        if (idx === effectiveUserCol) return userId; // always write verified userId/email
        // Do NOT auto-populate updatedAt; leave empty if client didn't provide
        return params[h] !== undefined ? params[h] : '';
      });
      const resp = await appendRow(accessToken, row);
      return res.json({ ok: true, result: resp });
    }

    if (action === 'update') {
      const params = body;
      if (!params.word) return res.status(400).json({ error: 'missing word' });
      if (values.length <= 1) return res.status(404).json({ error: 'not_found' });
      const rows = values.slice(1);
      let foundIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const uid = String(row[effectiveUserCol] || '').trim();
        const w = String(row[effectiveWordCol] || '').trim();
        if (w === String(params.word).trim() && uid.toLowerCase() === String(userId).toLowerCase()) { foundIndex = i; break; }
      }
      if (foundIndex === -1) return res.status(404).json({ error: 'not_found' });
      const sheetRowIndex = foundIndex + 2; // rows[] is values.slice(1); first data row -> sheet row 2
      const existing = rows[foundIndex];
      // Use batchUpdate to update only the fields provided in params (and always ensure userId col)
      const updates = [];
      for (let j = 0; j < hdr.length; j++) {
        const h = hdr[j];
        if (!h) continue;
        // Always ensure userId column matches authenticated user
        if (j === effectiveUserCol) {
          const colLetter = columnLetter(j);
          updates.push({ range: `${SHEET_NAME}!${colLetter}${sheetRowIndex}`, values: [[userId]] });
          continue;
        }
        // Skip updatedAt automatic writes: only update if client explicitly included field
        if (String(h || '').toLowerCase() === 'updatedat') {
          if (Object.prototype.hasOwnProperty.call(params, h)) {
            const colLetter = columnLetter(j);
            updates.push({ range: `${SHEET_NAME}!${colLetter}${sheetRowIndex}`, values: [[params[h]]] });
          }
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(params, h)) {
          const colLetter = columnLetter(j);
          updates.push({ range: `${SHEET_NAME}!${colLetter}${sheetRowIndex}`, values: [[params[h] !== undefined ? params[h] : '']] });
        }
      }
      if (updates.length === 0) return res.json({ ok: true, result: 'no_changes' });
      const resp = await batchUpdateValues(accessToken, updates);
      return res.json({ ok: true, result: resp });
    }

    if (action === 'delete') {
      const params = body;
      if (!params.word) return res.status(400).json({ error: 'missing word' });
      if (values.length <= 1) return res.status(404).json({ error: 'not_found' });
      const rows = values.slice(1);
      let foundIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const uid = String(row[effectiveUserCol] || '').trim();
        const w = String(row[effectiveWordCol] || '').trim();
        if (w === String(params.word).trim() && uid.toLowerCase() === String(userId).toLowerCase()) { foundIndex = i; break; }
      }
      if (foundIndex === -1) return res.status(404).json({ error: 'not_found' });
      // Delete the row by overwriting with empty strings (safe) — Apps Script deleted row physically,
      // physical deletion via Sheets API requires sheetId and batchUpdate; emulate by clearing values here.
      const emptyRow = hdr.map(() => '');
      const resp = await updateRow(accessToken, foundIndex + 2, emptyRow);
      return res.json({ ok: true, result: resp });
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    console.error('sheets-proxy error', e);
    return res.status(500).json({ error: 'internal_error', detail: String(e && e.message) });
  }
};
