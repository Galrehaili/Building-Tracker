/**
 * Building Shared Services Tracker — token relay worker
 * ------------------------------------------------------
 * Keeps your Google "refresh token" stored server-side (in Cloudflare KV)
 * so the app in the browser never needs to ask Google directly for a new
 * sign-in every time it's reopened. This is what lets iOS Safari (and any
 * browser blocking third-party auth cookies) stay signed in reliably.
 *
 * ROUTES
 *   POST /exchange    { code, redirect_uri }  -> one-time: turns the code
 *                       Google gave you after consent into a refresh token,
 *                       stores it, and returns a fresh access token.
 *   GET  /refresh                             -> uses the stored refresh
 *                       token to hand back a fresh access token. Called by
 *                       the app every time it needs one.
 *   POST /disconnect                          -> forgets the stored refresh
 *                       token (called when you tap "Disconnect" in Settings).
 *
 * Every request must include header:  X-App-Secret: <APP_SECRET>
 * — a shared password only your own app knows, so nobody who stumbles on
 * your worker's URL can pull your Google access token.
 *
 * SETUP (see the chat reply for the full walkthrough)
 *   1. Create a KV namespace, bind it to this worker as `TOKENS`.
 *   2. Add these as Worker Variables/Secrets:
 *        GOOGLE_CLIENT_ID      - same value as CONFIG.GOOGLE_CLIENT_ID in the app
 *        GOOGLE_CLIENT_SECRET  - from the same OAuth client in Google Cloud Console
 *        APP_SECRET            - any random string you invent
 *        ALLOWED_ORIGIN        - your GitHub Pages origin, e.g. https://yourname.github.io
 *   3. Paste this whole file into the Cloudflare Worker editor and deploy.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // Simple shared-secret check — every route requires it.
    if (request.headers.get('X-App-Secret') !== env.APP_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }

    try {
      if (url.pathname === '/exchange' && request.method === 'POST') {
        const { code, redirect_uri } = await request.json();
        if (!code || !redirect_uri) return json({ error: 'missing code or redirect_uri' }, 400);

        const body = new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri,
          grant_type: 'authorization_code',
        });
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        const data = await r.json();
        if (!r.ok) return json(data, r.status);

        if (data.refresh_token) {
          await env.TOKENS.put('refresh_token', data.refresh_token);
        } else {
          // Google only issues a refresh_token the FIRST time consent is granted
          // (or when prompt=consent forces it again). If this happens, the app
          // needs to disconnect and reconnect to get a fresh one.
          const existing = await env.TOKENS.get('refresh_token');
          if (!existing) return json({ error: 'no_refresh_token_issued' }, 400);
        }
        return json({ access_token: data.access_token, expires_in: data.expires_in });
      }

      if (url.pathname === '/refresh' && request.method === 'GET') {
        const refresh_token = await env.TOKENS.get('refresh_token');
        if (!refresh_token) return json({ error: 'not_connected' }, 400);

        const body = new URLSearchParams({
          refresh_token,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token',
        });
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        const data = await r.json();
        if (!r.ok) {
          // A revoked/expired refresh token means the user must reconnect.
          if (r.status === 400 || r.status === 401) await env.TOKENS.delete('refresh_token');
          return json(data, r.status);
        }
        return json({ access_token: data.access_token, expires_in: data.expires_in });
      }

      if (url.pathname === '/disconnect' && request.method === 'POST') {
        await env.TOKENS.delete('refresh_token');
        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },
};
