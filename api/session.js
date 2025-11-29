// Vercel serverless function: /api/session
// Usage:
// POST  /api/session { id_token }  -> verify id_token with Google, create HttpOnly session cookie
// GET   /api/session                -> check session cookie and return { loggedIn, userId }
// DELETE /api/session               -> clear session cookie (logout)

const crypto = require('crypto');

// Use SESSION_SECRET environment variable in Vercel settings
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_to_secure_secret';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_COOKIE_NAME = 'wb_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, bodyB64, sig] = parts;
    const data = `${headerB64}.${bodyB64}`;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
    const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${value}`];
  if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge/1000)}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      const { id_token } = req.body || {};
      if (!id_token) return res.status(400).json({ error: 'missing id_token' });

      // Verify id_token with Google tokeninfo endpoint
      const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`;
      const resp = await fetch(tokenInfoUrl);
      if (!resp.ok) return res.status(401).json({ error: 'invalid id_token' });
      const payload = await resp.json();

      // Ensure audience matches (if provided)
      if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
        return res.status(401).json({ error: 'aud_mismatch' });
      }

      const userId = payload.email || payload.sub;
      if (!userId) return res.status(400).json({ error: 'cannot_determine_user' });

      // create session payload
      const sessionPayload = {
        userId,
        iat: Date.now(),
        exp: Date.now() + SESSION_MAX_AGE
      };
      const token = sign(sessionPayload);

      // set HttpOnly secure cookie
      setCookie(res, SESSION_COOKIE_NAME, token, {
        maxAge: SESSION_MAX_AGE,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/'
      });

      return res.json({ ok: true, userId });
    }

    if (req.method === 'GET') {
      const cookie = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(SESSION_COOKIE_NAME+'='));
      if (!cookie) return res.json({ loggedIn: false });
      const token = cookie.split('=')[1];
      const payload = verify(token);
      if (!payload) return res.json({ loggedIn: false });
      return res.json({ loggedIn: true, userId: payload.userId });
    }

    if (req.method === 'DELETE') {
      clearCookie(res, SESSION_COOKIE_NAME);
      return res.json({ ok: true });
    }

    res.setHeader('Allow', 'GET,POST,DELETE');
    return res.status(405).end();
  } catch (e) {
    console.error('session function error', e);
    return res.status(500).json({ error: 'internal_error' });
  }
};
