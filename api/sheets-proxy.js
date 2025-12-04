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

async function getSpreadsheetMetadata(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error('sheets metadata failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function deleteSheetRow(accessToken, sheetId, sheetRow) {
  // sheetRow is 1-based row number in the spreadsheet
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`;
  const body = {
    requests: [
      {
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: sheetRow - 1,
            endIndex: sheetRow
          }
        }
      }
    ]
  };
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('sheets deleteRow failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function appendRow(accessToken, row) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A:Z:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const body = { values: [row] };
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('sheets append failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function updateRow(accessToken, rowIndex, row) {
  // rowIndex is 1-based excluding header (so actual sheet row = rowIndex + 1)
  const sheetRow = rowIndex + 1; // header is row 1
  // compute end column based on row length (A..Z..AA if needed)
  const colLetter = (n) => {
    let s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const endCol = colLetter(row.length || 1);
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

    // header columns expected (configured to match sheet tab column order)
    // Desired order: userId, word, meaning_jp, meaning, example, category, learned, streak, updatedAt
    // We'll read the actual header row from the sheet to respect the real column count.

    // read sheet once for operations so we know header length
    const sheetData = await readSheetValues(accessToken);
    const values = (sheetData.values || []);
    const hdr = values[0] ? values[0].map(h => String(h || '').trim()) : [];
    // Discover userId/word column indexes from header row (case-insensitive). Fall back to 0/1.
    const userColIndex = Math.max(0, hdr.findIndex(h => String(h || '').toLowerCase() === 'userid'));
    const wordColIndex = Math.max(1, hdr.findIndex(h => String(h || '').toLowerCase() === 'word'));
    if (action === 'list') {
      if (values.length <= 1) return res.json([]);
      // hdr already defined above
      const rows = values.slice(1).map(r => {
        const obj = {};
        for (let i=0;i<hdr.length;i++) obj[hdr[i]||('col'+i)] = r[i] || '';
        return obj;
      });
      // filter by userId (case-insensitive) using discovered column name
      const uidKey = hdr[userColIndex] || 'userId';
      const filtered = rows.filter(r => (String(r[uidKey]||'').trim().toLowerCase()) === String(userId||'').trim().toLowerCase());
      return res.json(filtered);
    }

    if (action === 'add') {
      const params = body;
      if (!params.word && !params.id) return res.status(400).json({ error: 'missing word' });
      // Build row aligned to actual headers. Do not auto-set updatedAt; leave empty.
      const row = hdr.map((h, idx) => {
        if (!h) return '';
        const key = String(h);
        if (idx === userColIndex) return userId;
        if (key.toLowerCase() === 'updatedat' || key === 'updatedAt') return '';
        const v = params[key];
        if (v === null || typeof v === 'undefined') return '';
        return (typeof v === 'string') ? v : String(v);
      });
      const resp = await appendRow(accessToken, row);
      return res.json({ ok: true, result: resp });
    }

    if (action === 'update') {
      const params = body;
      const wordParam = (params.word || params.id || '').toString().trim();
      if (!wordParam) return res.status(400).json({ error: 'missing word' });
      const hdr = values[0] ? values[0].map(h=>String(h||'').trim()) : [];
      const rows = values.slice(1 || 0);
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      let foundIndex = -1;
      for (let i=0;i<rows.length;i++){
        const row = rows[i];
        const uid = String(row[0]||'').trim();
        const w = String(row[1]||'').trim();
        if (w === wordParam && uid.toLowerCase() === String(userId).toLowerCase()) { foundIndex = i; break; }
      }
      if (foundIndex === -1) return res.status(404).json({ error: 'not_found' });
      const existingRow = rows[foundIndex] || [];
      // Normalize existingRow length to header length
      for (let i = 0; i < hdr.length; i++) if (typeof existingRow[i] === 'undefined') existingRow[i] = '';
      // Merge: keep existing values unless params provides a meaningful (non-empty) value
      const merged = hdr.map((h, idx) => {
        const key = String(h || '');
        const lower = key.toLowerCase();
        if (!key) return existingRow[idx] || '';
        // never allow client to set updatedAt
        if (lower === 'updatedat' || key === 'updatedAt') return existingRow[idx] || '';
        // user id column forced to server userId
        if (idx === 0) return userId;
        if (Object.prototype.hasOwnProperty.call(params, key)) {
          const v = params[key];
          if (v === null || typeof v === 'undefined') return existingRow[idx] || '';
          if (typeof v === 'string') {
            if (v.trim() === '') return existingRow[idx] || '';
            return v;
          }
          // non-string (number/boolean) -> convert to string
          return String(v);
        }
        return existingRow[idx] || '';
      });
      // updateRow expects rowIndex (1-based excluding header) as before
      const resp = await updateRow(accessToken, foundIndex+1, merged);
      // return merged row for debugging/verification
      return res.json({ ok: true, result: resp, writtenRow: merged });
    }

    if (action === 'delete') {
      const params = body;
      const wordParam = (params.word || params.id || '').toString().trim();
      if (!wordParam) return res.status(400).json({ error: 'missing word' });
      const hdr = values[0] ? values[0].map(h=>String(h||'').trim()) : [];
      const rows = values.slice(1 || 0);
      let foundIndex = -1;
      for (let i=0;i<rows.length;i++){
        const row = rows[i];
        const uid = String(row[0]||'').trim();
        const w = String(row[1]||'').trim();
        if (w === wordParam && uid.toLowerCase() === String(userId).toLowerCase()) { foundIndex = i; break; }
      }
      if (foundIndex === -1) return res.status(404).json({ error: 'not_found' });
      // Prefer physical row deletion so indexes remain compact and matches Apps Script behavior
      try {
        const meta = await getSpreadsheetMetadata(accessToken);
        const sheets = (meta.sheets || []).map(s => s.properties || {});
        const sheetProp = sheets.find(s => s.title === SHEET_NAME) || sheets[0] || {};
        const sheetId = sheetProp.sheetId;
        const sheetRow = foundIndex + 2; // foundIndex=0 -> sheet row 2 (header is row 1)
        if (typeof sheetId !== 'undefined') {
          const delResp = await deleteSheetRow(accessToken, sheetId, sheetRow);
            return res.json({ ok: true, result: delResp, deletedRow: sheetRow, sheetId });
        }
      } catch (err) {
        // fallback: clear the row if physical delete fails
        const emptyRow = new Array(hdr.length || 1).fill('');
        const resp = await updateRow(accessToken, foundIndex+1, emptyRow);
          return res.json({ ok: true, result: resp, fallback: 'cleared_row', clearedRowIndex: foundIndex+1 });
      }
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    console.error('sheets-proxy error', e);
    return res.status(500).json({ error: 'internal_error', detail: String(e && e.message) });
  }
};
