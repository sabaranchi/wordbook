const CLIENT_ID = '631768968773-jakkcpa1ia1qb8rnec2mj4jqp6ohnoc5.apps.googleusercontent.com';

function verifyIdToken(idToken) {
  if (!idToken) return null;
  try {
    const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    const payload = JSON.parse(resp.getContentText());
    // aud が自分の CLIENT_ID と一致するか確認
    if (payload.aud !== CLIENT_ID) return null;
    // ここで追加チェックがあれば行う（exp など）
    return payload; // payload.sub, payload.email, などが使える
  } catch (e) {
    return null;
  }
}

function _readSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = sheet.getDataRange().getValues();
  if (!data || data.length === 0) return { sheet, headers: [], rows: [] };
  const headers = data[0];
  const rows = data.slice(1);
  return { sheet, headers, rows, raw: data };
}

/** Normalize a row object built from sheet into a clean object that always has 'word'.
 * Returns null if no usable word can be determined (row should be skipped).
 */
function _normalizeRowObject(obj, headers) {
  const normalized = {};
  // copy as strings
  headers.forEach(function(h) {
    const key = String(h || '').trim();
    const v = obj[key];
    normalized[key] = (v === undefined || v === null) ? '' : String(v);
  });

  // determine word
  var wordVal = undefined;
  if (Object.prototype.hasOwnProperty.call(normalized, 'word')) wordVal = normalized['word'];
  if (!wordVal) {
    var alt = Object.keys(normalized).find(function(k){ return k.toLowerCase() === 'word'; });
    if (alt) wordVal = normalized[alt];
  }
  if (!wordVal && Object.prototype.hasOwnProperty.call(normalized, 'id')) wordVal = normalized['id'];
  if (!wordVal) {
    for (var i = 0; i < headers.length; i++) {
      var key = String(headers[i] || '').trim();
      if (key && normalized[key] && String(normalized[key]).trim() !== '') { wordVal = normalized[key]; break; }
    }
  }
  if (!wordVal || String(wordVal).trim() === '') return null;
  normalized.word = String(wordVal).trim();
  return normalized;
}

function _normalizeObjects(objects, headers) {
  var out = [];
  objects.forEach(function(o){
    var n = _normalizeRowObject(o, headers);
    if (n) out.push(n);
  });
  return out;
}

function doGet(e) {
  // 互換性のためそのまま全件返す（クライアント側でフィルタ）か、
  // id_token がある場合はそのユーザー分だけ返します
  const params = e.parameter || {};
  const idToken = params.id_token || params.idToken || null;
  const payload = verifyIdToken(idToken);

  const { headers, rows } = _readSheet();
  // headers: [ 'userId', 'word', 'meaning', ... ] の形式を想定
  const objects = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  // normalize rows so each returned object has a valid 'word' property
  const normalized = _normalizeObjects(objects, headers);

  let result;
  if (payload && payload.email) {
    // id_token 検証に成功 -> email で絞る（スプレッドシートの1列目が email/userId である想定）
    const email = payload.email;
    result = normalized.filter(r => String(r[headers[0]] || '') === String(email));
  } else {
    // デフォルト: 全件返す（既存のクライアント互換性維持）
    result = normalized;
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // POST は application/json または x-www-form-urlencoded に対応
  const params = e.parameter || {};
  let item = {};
  if (e.postData && e.postData.type === 'application/json') {
    try {
      item = JSON.parse(e.postData.contents);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'invalid_json' })).setMimeType(ContentService.MimeType.JSON);
    }
  } else if (e.postData && e.postData.type === 'application/x-www-form-urlencoded') {
    // Urlencoded は e.parameter に入っている
    item = Object.assign({}, params);
  } else {
    // fallback
    item = params;
  }

  const action = (item.action || params.action || '').toString();
  // accept id_token in either field name to be forgiving
  const idToken = (item.id_token || item.idToken || params.id_token || params.idToken) || null;
  const payload = verifyIdToken(idToken);

  const { sheet, headers, rows, raw } = _readSheet();
  // ヘッダの最初の列を userId/email として扱う（必要ならここを変更）
  const userColIndex = 0;
  const wordColIndex = 1;

  // ヘルパ: 行検索（raw を使って行番号を計算）
  // userIds: 配列で可能なユーザー識別子を渡すとどれか一致すればヒットする
  function findRowIndexByUserAndWord(userIds, wordVal) {
    const normUserIds = (Array.isArray(userIds) ? userIds : [userIds]).map(u => String(u||'').trim().toLowerCase()).filter(Boolean);
    for (let i = 1; i < raw.length; i++) {
      const row = raw[i];
      const u = row[userColIndex] !== undefined ? String(row[userColIndex]) : '';
      const w = row[wordColIndex] !== undefined ? String(row[wordColIndex]) : '';
      if (String(w) === String(wordVal) && normUserIds.indexOf(String(u).trim().toLowerCase()) !== -1) return i; // raw index
    }
    return -1;
  }

  // ---- verify action ----
  if ((action === 'verify' || action === 'verifyLogin') && idToken) {
    if (!payload) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'invalid_token' })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ success: true, userId: payload.sub, email: payload.email })).setMimeType(ContentService.MimeType.JSON);
  }

  // ---- list action (オプション) ----
  if (action === 'list') {
    // id_token があればそのユーザー分のみ返す（非公開化）、なければ全件返す（従来互換）
    const objects = rows.map(r => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = r[i]);
      return obj;
    });
    const normalized = _normalizeObjects(objects, headers);
    if (payload && payload.email) {
      const email = payload.email;
      const filtered = normalized.filter(r => String(r[headers[userColIndex]] || '') === String(email));
      return ContentService.createTextOutput(JSON.stringify(filtered)).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify(normalized)).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 以下は書き込み系（add/update/delete） -> トークン必須にする
  if (!payload) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'token_required' })).setMimeType(ContentService.MimeType.JSON);
  }
  // 確認されたユーザー識別子（email を優先。無ければ sub を使う）
  const authedUser = payload.email || payload.sub;
  // 複数の候補を用意（email と sub を両方使って行を検索できるようにする）
  const possibleUserIds = [];
  if (payload.email) possibleUserIds.push(String(payload.email));
  if (payload.sub) possibleUserIds.push(String(payload.sub));
  if (authedUser && possibleUserIds.indexOf(String(authedUser)) === -1) possibleUserIds.push(String(authedUser));

  // ---- delete ----
  if (action === 'delete') {
    const wordToDelete = item.word || item.id || '';
    if (!wordToDelete) return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'no_word' })).setMimeType(ContentService.MimeType.JSON);
    const rowIdx = findRowIndexByUserAndWord(possibleUserIds, wordToDelete);
    if (rowIdx > 0) {
      // raw index -> spreadsheet row = rowIdx + 1
      sheet.deleteRow(rowIdx + 1);
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: 'deleted' })).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'not_found' })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ---- update ----
  if (action === 'update') {
    const wordToUpdate = item.word || '';
    if (!wordToUpdate) return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'no_word' })).setMimeType(ContentService.MimeType.JSON);
    const rowIdx = findRowIndexByUserAndWord(possibleUserIds, wordToUpdate);
    if (rowIdx > 0) {
      // headers を走査して、item に含まれるキーだけ更新
      // ※ クイズ等で learned/streak のみ更新する際に他列を空で上書きしないよう、
      //    空文字列 (''), null, undefined の場合は上書きしない仕様にする
      headers.forEach((h, j) => {
        if (!Object.prototype.hasOwnProperty.call(item, h)) return; // キーが存在しなければ無視
        // Skip updatedAt column: do not set/update updatedAt from client
        if (String(h).toLowerCase() === 'updatedat' || String(h) === 'updatedAt') return;
        const val = item[h];
        if (val === null || typeof val === 'undefined') return;
        // treat empty-string as "no-update" to avoid accidental blanking
        if (typeof val === 'string' && val.trim() === '') return;
        sheet.getRange(rowIdx + 1, j + 1).setValue(val);
      });
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: 'updated' })).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'not_found' })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ---- add (append) ----
  if (action === 'add' || !action) {
    // item のフィールドを headers の順にして1行を生成
    // ※ updatedAt を自動で追加しない（クライアントからの追加でもタイムスタンプは挿入しない）
    const row = headers.map(h => {
      if (h === headers[userColIndex]) return authedUser; // user 列は必ず authedUser を書き込む（なりすまし防止）
      if (String(h).toLowerCase() === 'updatedat' || String(h) === 'updatedAt') return '';
      return item[h] !== undefined ? item[h] : '';
    });
    sheet.appendRow(row);
    return ContentService.createTextOutput(JSON.stringify({ success: true, action: 'added' })).setMimeType(ContentService.MimeType.JSON);
  }

  // 未知の action の場合
  return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'unknown_action' })).setMimeType(ContentService.MimeType.JSON);
}










もと
const CLIENT_ID = '631768968773-jakkcpa1ia1qb8rnec2mj4jqp6ohnoc5.apps.googleusercontent.com';

function verifyIdToken(idToken) {
  if (!idToken) return null;
  try {
    const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    const payload = JSON.parse(resp.getContentText());
    // aud が自分の CLIENT_ID と一致するか確認
    if (payload.aud !== CLIENT_ID) return null;
    // ここで追加チェックがあれば行う（exp など）
    return payload; // payload.sub, payload.email, などが使える
  } catch (e) {
    return null;
  }
}

function _readSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = sheet.getDataRange().getValues();
  if (!data || data.length === 0) return { sheet, headers: [], rows: [] };
  const headers = data[0];
  const rows = data.slice(1);
  return { sheet, headers, rows, raw: data };
}

/** Normalize a row object built from sheet into a clean object that always has 'word'.
 * Returns null if no usable word can be determined (row should be skipped).
 */
function _normalizeRowObject(obj, headers) {
  const normalized = {};
  // copy as strings
  headers.forEach(function(h) {
    const key = String(h || '').trim();
    const v = obj[key];
    normalized[key] = (v === undefined || v === null) ? '' : String(v);
  });

  // determine word
  var wordVal = undefined;
  if (Object.prototype.hasOwnProperty.call(normalized, 'word')) wordVal = normalized['word'];
  if (!wordVal) {
    var alt = Object.keys(normalized).find(function(k){ return k.toLowerCase() === 'word'; });
    if (alt) wordVal = normalized[alt];
  }
  if (!wordVal && Object.prototype.hasOwnProperty.call(normalized, 'id')) wordVal = normalized['id'];
  if (!wordVal) {
    for (var i = 0; i < headers.length; i++) {
      var key = String(headers[i] || '').trim();
      if (key && normalized[key] && String(normalized[key]).trim() !== '') { wordVal = normalized[key]; break; }
    }
  }
  if (!wordVal || String(wordVal).trim() === '') return null;
  normalized.word = String(wordVal).trim();
  return normalized;
}

function _normalizeObjects(objects, headers) {
  var out = [];
  objects.forEach(function(o){
    var n = _normalizeRowObject(o, headers);
    if (n) out.push(n);
  });
  return out;
}

function doGet(e) {
  // 互換性のためそのまま全件返す（クライアント側でフィルタ）か、
  // id_token がある場合はそのユーザー分だけ返します
  const params = e.parameter || {};
  const idToken = params.id_token || params.idToken || null;
  const payload = verifyIdToken(idToken);

  const { headers, rows } = _readSheet();
  // headers: [ 'userId', 'word', 'meaning', ... ] の形式を想定
  const objects = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  // normalize rows so each returned object has a valid 'word' property
  const normalized = _normalizeObjects(objects, headers);

  let result;
  if (payload && payload.email) {
    // id_token 検証に成功 -> email で絞る（スプレッドシートの1列目が email/userId である想定）
    const email = payload.email;
    result = normalized.filter(r => String(r[headers[0]] || '') === String(email));
  } else {
    // デフォルト: 全件返す（既存のクライアント互換性維持）
    result = normalized;
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // POST は application/json または x-www-form-urlencoded に対応
  const params = e.parameter || {};
  let item = {};
  if (e.postData && e.postData.type === 'application/json') {
    try {
      item = JSON.parse(e.postData.contents);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'invalid_json' })).setMimeType(ContentService.MimeType.JSON);
    }
  } else if (e.postData && e.postData.type === 'application/x-www-form-urlencoded') {
    // Urlencoded は e.parameter に入っている
    item = Object.assign({}, params);
  } else {
    // fallback
    item = params;
  }

  const action = (item.action || params.action || '').toString();
  // accept id_token in either field name to be forgiving
  const idToken = (item.id_token || item.idToken || params.id_token || params.idToken) || null;
  const payload = verifyIdToken(idToken);

  const { sheet, headers, rows, raw } = _readSheet();
  // ヘッダの最初の列を userId/email として扱う（必要ならここを変更）
  const userColIndex = 0;
  const wordColIndex = 1;

  // ヘルパ: 行検索（raw を使って行番号を計算）
  function findRowIndexByUserAndWord(userIdVal, wordVal) {
    // raw[0] は headers, raw[1] は 1 行目データ => spreadsheet row は index+1
    for (let i = 1; i < raw.length; i++) {
      const row = raw[i];
      const u = row[userColIndex] !== undefined ? String(row[userColIndex]) : '';
      const w = row[wordColIndex] !== undefined ? String(row[wordColIndex]) : '';
      if (u === String(userIdVal) && w === String(wordVal)) return i; // i は raw index -> spreadsheet row = i+1
    }
    return -1;
  }

  // ---- verify action ----
  if ((action === 'verify' || action === 'verifyLogin') && idToken) {
    if (!payload) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'invalid_token' })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ success: true, userId: payload.sub, email: payload.email })).setMimeType(ContentService.MimeType.JSON);
  }

  // ---- list action (オプション) ----
  if (action === 'list') {
    // id_token があればそのユーザー分のみ返す（非公開化）、なければ全件返す（従来互換）
    const objects = rows.map(r => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = r[i]);
      return obj;
    });
    const normalized = _normalizeObjects(objects, headers);
    if (payload && payload.email) {
      const email = payload.email;
      const filtered = normalized.filter(r => String(r[headers[userColIndex]] || '') === String(email));
      return ContentService.createTextOutput(JSON.stringify(filtered)).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify(normalized)).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 以下は書き込み系（add/update/delete） -> トークン必須にする
  if (!payload) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'token_required' })).setMimeType(ContentService.MimeType.JSON);
  }
  // 確認されたユーザー識別子（email を優先。無ければ sub を使う）
  const authedUser = payload.email || payload.sub;

  // ---- delete ----
  if (action === 'delete') {
    const wordToDelete = item.word || item.id || '';
    if (!wordToDelete) return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'no_word' })).setMimeType(ContentService.MimeType.JSON);
    const rowIdx = findRowIndexByUserAndWord(authedUser, wordToDelete);
    if (rowIdx > 0) {
      sheet.deleteRow(rowIdx + 1); // raw index -> spreadsheet row
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: 'deleted' })).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'not_found' })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ---- update ----
  if (action === 'update') {
    const wordToUpdate = item.word || '';
    if (!wordToUpdate) return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'no_word' })).setMimeType(ContentService.MimeType.JSON);
    const rowIdx = findRowIndexByUserAndWord(authedUser, wordToUpdate);
    if (rowIdx > 0) {
      // headers を走査して、item に含まれるキーだけ更新
      headers.forEach((h, j) => {
        if (Object.prototype.hasOwnProperty.call(item, h)) {
          sheet.getRange(rowIdx + 1, j + 1).setValue(item[h]);
        }
      });
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: 'updated' })).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'not_found' })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ---- add (append) ----
  if (action === 'add' || !action) {
    // item のフィールドを headers の順にして1行を生成
    const row = headers.map(h => {
      if (h === headers[userColIndex]) return authedUser; // user 列は必ず authedUser を書き込む（なりすまし防止）
      // item[h] が無ければ空文字
      return item[h] !== undefined ? item[h] : '';
    });
    sheet.appendRow(row);
    return ContentService.createTextOutput(JSON.stringify({ success: true, action: 'added' })).setMimeType(ContentService.MimeType.JSON);
  }

  // 未知の action の場合
  return ContentService.createTextOutput(JSON.stringify({ success: false, err: 'unknown_action' })).setMimeType(ContentService.MimeType.JSON);
}
