# クラウドデータ保存・連携と Google ログイン（id_token）入門ガイド

このドキュメントは、ブラウザで動く単純な語彙帳アプリ（WordBook）のような小さな Web アプリを想定して、
「クラウド保存の選択肢」「ローカル（IndexedDB）との連携パターン」「Google Identity Services（id_token）によるログイン実装」
を初心者向けに分かりやすくまとめたものです。コード例、デプロイ前チェックリスト、よくある落とし穴、デバッグ方法を含みます。

---

## 目次
1. 概要（アプリのデータフロー）
2. 保存先の候補（利点・欠点）
3. 設計パターン: ローカルキャッシュ + クラウド同期
4. セキュリティ：なぜ id_token を使うか
5. クライアント実装（Google Identity Services）
6. サーバ実装（Apps Scriptでの id_token 検証 + Sheets 操作）
7. IndexedDB の安全な保存（wrapper）
8. 同期（reconcile）フロー実装例
9. よくある問題と対策（デバッグガイド）
10. デプロイ前チェックリスト
11. 参考リンク

---

## 1. 概要（アプリのデータフロー）
クライアント（ブラウザ）で Google にログインして `id_token`（JWT）を受け取る。
受け取った `id_token` を Apps Script（または自前 API）に渡して検証し、検証済みとしてシートやデータベースへの read/write を許可する。
クライアント側では IndexedDB にローカルキャッシュを持ち、最初はローカルを表示して素早い体験を提供し、背景でサーバと同期する。

テキスト図:
```
Client (UI) <-> IndexedDB (local cache)
     |
     +--(id_token付きAPI呼び出し)--> Apps Script/API (verify id_token) --> Google Sheets / DB
```

---

## 2. 保存先の候補（利点・欠点）
- Google Sheets + Apps Script
  - 利点: 簡単に始められる。GUIで編集可能。
  - 欠点: 大量データ・複雑クエリは苦手。競合/同時更新制御を自前で実装する必要がある。

- Firebase Firestore / Realtime DB
  - 利点: リアルタイム同期、スケーラブル、公式 SDK が便利。
  - 欠点: 認証設計（rules）が必要。料金モデルに注意。

- Cloud SQL (Postgres/MySQL)
  - 利点: リレーショナルなクエリやトランザクション。
  - 欠点: API 層が必要で運用が複雑。

- S3 / GCS + API
  - 利点: 静的コンテンツやメディアに強い。
  - 欠点: 小規模アプリには過剰。API 層が必要。

**初心者向けおすすめ**: 少量データなら Google Sheets + Apps Script（手軽）。将来スケールするなら Firestore か専用 API に移行。

---

## 3. 設計パターン: ローカルキャッシュ + クラウド同期
目標: オフライン耐性、速い初期表示、最終的整合性を持つ。

一般パターン（ローカルファースト）:
1. ページロード -> IndexedDB から読み込み -> すぐに描画（ユーザーの体感が速い）
2. 同時にサーバから最新リストを取得 -> IndexedDB に書き込み（上書き or マージ）
3. ローカルのみの更新がある場合はサーバに push
4. 衝突は updatedAt を比較して newer-wins か、ユーザーに選ばせる

注意: ネットワークエラー、トランザクション途中の失敗、DB スキーマ変更（versioning）などを考慮する。

---

## 4. セキュリティ：なぜ id_token を使うか
- id_token は Google が発行する JWT（署名付き）。発行者（iss）、受取対象（aud）、発行/失効時刻（iat/exp）などが含まれる。
- ブラウザ側で得た id_token をそのままサーバに渡し、サーバで検証することで「この API 呼び出しは本当にその Google ユーザーによるものか」を確認する。
- クライアント側での検証は信用できない。必ずサーバ側でも `aud`(クライアントID) と `exp` を確認する。

---

## 5. クライアント実装（Google Identity Services）
### 前提
- Google Cloud Console で OAuth クライアント（Web アプリ）を作成し、Client ID を取得していること。
- `Authorized JavaScript origins` にサイトの origin（例: https://yourdomain）を登録していること。

### 基本的なコード（HTML 側）
```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
<div id="g_id_button"></div>
```

### 初期化とコールバック（JS）
```javascript
const GOOGLE_CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
let currentIdToken = null;

function initGoogleIdentity() {
  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false
  });
  window.google.accounts.id.renderButton(document.getElementById('g_id_button'), { theme: 'outline', size: 'large' });
}

function handleCredentialResponse(resp) {
  if (!resp || !resp.credential) return;
  currentIdToken = resp.credential; // JWT
  sessionStorage.setItem('id_token', currentIdToken);
  // parseJwt はデバッグ/表示用関数
  const payload = parseJwt(currentIdToken);
  // ここで UI 更新やサーバ同期を呼ぶ
}
```

### id_token を送る（API 呼び出し）
```javascript
async function callApi(action, params={}){
  const body = new URLSearchParams();
  body.append('action', action);
  Object.keys(params).forEach(k => body.append(k, params[k]));
  if (currentIdToken) body.append('id_token', currentIdToken);

  const res = await fetch('https://your-apps-script-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body
  });
  return res.json();
}
```

注意点:
- id_token の期限（exp）がある → 再ログインやリフレッシュの考慮。
- COOP/COEP による postMessage の問題がある環境では、リダイレクト型のフォールバック実装を検討。

---

## 6. サーバ実装（Apps Script の例）
最小の `doPost(e)` で id_token を検証し、Sheets を扱う例です。実運用では例外処理やログ、aud の確認などを丁寧に行ってください。

```javascript
function doPost(e){
  const params = e.parameter || {};
  const idToken = params.id_token;
  if (!idToken) return ContentService.createTextOutput(JSON.stringify({error:'missing id_token'})).setMimeType(ContentService.MimeType.JSON);

  // Google の tokeninfo で検証
  const tokenInfoUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  const resp = UrlFetchApp.fetch(tokenInfoUrl, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return ContentService.createTextOutput(JSON.stringify({ error: 'invalid token' })).setMimeType(ContentService.MimeType.JSON);
  const payload = JSON.parse(resp.getContentText());

  const CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
  if (payload.aud !== CLIENT_ID) return ContentService.createTextOutput(JSON.stringify({ error: 'aud_mismatch' })).setMimeType(ContentService.MimeType.JSON);

  const userId = payload.email || payload.sub;
  const action = params.action;
  if (action === 'list'){
    const rows = readRowsForUser(userId);
    return ContentService.createTextOutput(JSON.stringify(rows)).setMimeType(ContentService.MimeType.JSON);
  }
  // add/update/delete などの処理を実装
}

function readRowsForUser(userId){
  const ss = SpreadsheetApp.openById('SPREADSHEET_ID');
  const sheet = ss.getSheetByName('words');
  const data = sheet.getDataRange().getValues();
  const header = data.shift();
  return data.map(row => {
    const obj = {};
    header.forEach((h,i)=> obj[h]=String(row[i]||'').trim());
    return obj;
  }).filter(r => (r.userId||'').toLowerCase() === (userId||'').toLowerCase());
}
```

補足:
- `tokeninfo` は簡単ですが、トラフィックが多い場合は公開鍵での JWT 検証に切替える（高速化と自前キャッシュ）。
- Apps Script の「Web アプリとして公開」では実行ユーザーとアクセス権に注意（実行者: 自分 ／ アクセス: Anyone など）。

---

## 7. IndexedDB の安全な保存（wrapper）
IndexedDB に put するときに DataError が発生する主な原因は、keyPath（例: 'word'）が undefined / null であることや、プロトタイプ付きの特殊オブジェクトを入れていることです。

安全な `put` の例:

```javascript
function safePut(store, obj){
  try{
    if (!obj || typeof obj.word === 'undefined' || obj.word === null) { console.warn('skip put missing word', obj); return; }
    const w = (typeof obj.word==='string') ? obj.word.trim() : String(obj.word);
    if (!w) { console.warn('skip put empty word', obj); return; }
    const plain = Object.assign({}, obj);
    plain.word = w;
    return store.put(plain);
  }catch(e){ console.warn('safePut failed', e, obj); }
}
```

DB 開閉の標準パターンと組み合わせて使ってください（onupgradeneeded で objectStore を作る等）。

---

## 8. 同期（reconcile）フローの疑似コード
```
onLoad:
  local = readLocalAll()
  render(local)
  if (loggedIn) {
    server = await fetchServer('list')
    // merge/overwrite
    merged = reconcile(local, server)
    writeLocal(merged)
    render(merged)
  }
```

単純なマージ戦略:
- serverRows と localRows を `word` でマッチング
- 両方にある場合は `updatedAt` を比べて新しい方を採用
- local にのみある変更は server に push
- server のみにある行は local に取り込む

---

## 9. よくある問題と対策（デバッグガイド）
- aud mismatch → Cloud Console の Client ID が一致しているか確認
- token expired → 再ログインや token 再取得を実装
- IndexedDB DataError → safePut を使う、DB スキーマを確認
- CORS / CSP → Apps Script 側や配信側のヘッダを確認
- COOP/COEP と iframe → 広告や GIS が動かない場合はリダイレクト型のログインを検討

デバッグ手順:
1. DevTools の Console/Network を開く
2. handleCredentialResponse が呼ばれて `id_token` が sessionStorage に入ることを確認
3. `id_token` を tokeninfo に投げて 200 が返ることを確認
4. `callApi('list')` が 200 & JSON を返すことを確認
5. IndexedDB にデータが保存されていることを Application タブで確認

---

## 10. デプロイ前チェックリスト
- [ ] サイトが HTTPS で公開されている
- [ ] Google Cloud Console で Client ID を作成し、Authorized JS origins に本番の origin を追加
- [ ] Apps Script を Web App としてデプロイし、URL を控える
- [ ] `script.js` の `SHEET_API_URL` を Apps Script の URL に設定
- [ ] プライバシーポリシーを用意（AdSense 等の審査用）
- [ ] CSP / COOP / COEP の設定が広告と互換であることを確認

---

## 11. 参考リンク
- Google Identity Services: https://developers.google.com/identity/gsi/web
- OAuth2 tokeninfo: https://oauth2.googleapis.com/tokeninfo
- Google Apps Script: https://developers.google.com/apps-script
- IndexedDB MDN: https://developer.mozilla.org/ja/docs/Web/API/IndexedDB_API

---

## 12. 次のステップ（私が手伝えること）
- `script.js` と `GAS.txt` を実際の Client ID / SPREADSHEET_ID に差し替えて最小動作サンプルを作る
- Apps Script のデプロイ手順を GUI スクショ付きで案内
- IndexedDB wrapper と reconcile の実装をあなたのコードにパッチで当てる

---

以上。必要であれば、この Markdown を別名（README.md など）で保存して GitHub Pages や Vercel に配置できます。どの作業を次に進めますか？
