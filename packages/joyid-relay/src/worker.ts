// Worker routing layer. Consumers compose an ExportedHandler via
// makeRelayWorker(opts) and re-export AuthSession as the DO class.

import type { RelayEnv } from './env';

export interface TxPreviewPayload {
  title: string;
  amount?: string;
  details: Array<{ label: string; value: string; mono?: boolean }>;
  network?: 'testnet' | 'mainnet';
}

// Minimal HTML escaper — the preview strings are dApp-supplied so we
// need to defend against `<`/`>`/`&`/`"`/`'` ending up as active markup.
// Still no-JS: strings only come from trusted CORS origins, but belt
// and braces here since they get rendered into HTML attributes + text.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RelayWorkerOptions {
  /**
   * Explicit list of Origins allowed to create / poll sessions. The
   * /callback route is hit by the phone browser as a top-level
   * navigation (not fetch), so it doesn't need CORS — these are only
   * consulted for fetch-initiated /session and /session/:id.
   *
   * Pass the dApp origins that legitimately create connect sessions —
   * e.g. ['https://mydapp.xyz', 'http://localhost:5173'].
   */
  allowedOrigins: string[];

  /**
   * Optional branded logo served at GET /logo.png. Useful to pass to
   * JoyID as the dApp icon so the JoyID app renders your brand during
   * auth instead of a generic spinner. The public URL of this endpoint
   * becomes the `appIcon` you pass to `<JoyIDConnectProvider>`.
   */
  logo?: {
    contentType: string;
    base64: string;
  };
}

const SESSION_TTL_SECONDS = 120;

export function makeRelayWorker(opts: RelayWorkerOptions): ExportedHandler<RelayEnv> {
  const allowSet = new Set(opts.allowedOrigins);

  const corsHeaders = (origin: string | null): HeadersInit => {
    const allow = origin && allowSet.has(origin) ? origin : '';
    return {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  };

  const json = (body: unknown, origin: string | null, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });

  const stubFor = (env: RelayEnv, id: string): DurableObjectStub => {
    return env.AUTH_SESSION.get(env.AUTH_SESSION.idFromName(id));
  };

  const htmlPage = (title: string, body: string, ok: boolean, logoDataUrl: string | null): Response => {
    const glow = ok ? '#1fd6a8' : '#ff6b6b';
    const logoMarkup = logoDataUrl
      ? `<img src="${logoDataUrl}" width="72" height="72" alt="" />`
      : `<div style="width:14px;height:14px;border-radius:50%;background:${glow};margin:0 auto 16px;box-shadow:0 0 24px ${glow}55"></div>`;
    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d10;color:#e6e8eb;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
  .card{max-width:360px}
  .logo{display:inline-block;margin:0 auto 20px;filter:drop-shadow(0 0 28px ${glow}55)}
  h1{margin:0 0 8px;font-size:20px;font-weight:600}
  p{margin:0;color:#b5bcc4;font-size:15px}
</style>
</head>
<body><main><div class="card"><div class="logo">${logoMarkup}</div><h1>${title}</h1><p>${body}</p></div></main></body></html>`;
    return new Response(html, {
      status: ok ? 200 : 400,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  const logoDataUrl = opts.logo
    ? `data:${opts.logo.contentType};base64,${opts.logo.base64}`
    : null;

  const handleCreate = async (env: RelayEnv, origin: string | null): Promise<Response> => {
    const sessionId = crypto.randomUUID();
    const stub = stubFor(env, sessionId);
    const res = await stub.fetch('https://do/create', { method: 'POST' });
    if (!res.ok) return json({ error: 'failed to create session' }, origin, 500);
    return json({ id: sessionId, ttl: SESSION_TTL_SECONDS }, origin);
  };

  // Atomic create+arm for sign flows. Returns a short `launchUrl` the PC
  // shows as QR — scanning it lands on /tx-launch/:id which renders a
  // human-readable preview of the tx with Confirm/Cancel buttons.
  // Confirm then 302s to the stored JoyID `/sign-message` URL. Avoids
  // both pushing multi-KB payloads through a QR AND the blind-signing
  // problem (JoyID's sign-message UI shows only a hex hash).
  //
  // The client MUST supply the session id. This is a deliberate choice:
  // a JoyID sign URL embeds its own `redirectURL = callback(id)` into
  // the `_data_` payload, so the client needs to know the id BEFORE
  // POSTing the URL here. Forcing a server-generated id would require
  // a two-round create→arm handshake. Client-generated random UUIDs
  // are fine — the DO keyed by `idFromName` gives us strong consistency,
  // and an attacker guessing a session id still can't produce a valid
  // JoyID response without Face ID on an enrolled device.
  const handleTxSession = async (
    env: RelayEnv,
    origin: string | null,
    request: Request,
    url: URL,
  ): Promise<Response> => {
    let body: { id?: string; joyidSignUrl?: string; preview?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: 'invalid json body' }, origin, 400);
    }
    if (!body.id || typeof body.id !== 'string') {
      return json({ error: 'id required' }, origin, 400);
    }
    if (!body.joyidSignUrl || typeof body.joyidSignUrl !== 'string') {
      return json({ error: 'joyidSignUrl required' }, origin, 400);
    }

    const sessionId = body.id;
    const stub = stubFor(env, sessionId);

    const createRes = await stub.fetch('https://do/create', { method: 'POST' });
    if (!createRes.ok) {
      return json({ error: 'failed to create session' }, origin, 500);
    }
    const armRes = await stub.fetch('https://do/arm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        joyidSignUrl: body.joyidSignUrl,
        preview: body.preview,
      }),
    });
    if (!armRes.ok) {
      return json({ error: 'failed to arm session' }, origin, 500);
    }

    // Worker's origin serves as the base for the launchUrl — callers hit
    // the Worker at whatever domain routes to it (.workers.dev or a
    // custom domain), so we reflect that back.
    const launchUrl = `${url.origin}/tx-launch/${sessionId}`;
    return json({ id: sessionId, launchUrl, ttl: SESSION_TTL_SECONDS }, origin);
  };

  // Phone lands here via QR scan. Render the preview page (or fall
  // back to direct 302 if no preview was staged for legacy callers).
  // No CORS — this is a top-level navigation.
  const handleTxLaunch = async (
    env: RelayEnv,
    id: string,
    url: URL,
  ): Promise<Response> => {
    const stub = stubFor(env, id);
    const res = await stub.fetch('https://do/launch');
    if (res.status === 410) {
      return htmlPage(
        'Session expired',
        'This signing request has already expired. Start a new one on your computer.',
        false,
        logoDataUrl,
      );
    }
    if (res.status === 409) {
      return htmlPage(
        'Already used',
        'This signing request has already been completed. Return to your computer.',
        false,
        logoDataUrl,
      );
    }
    if (!res.ok) {
      return htmlPage(
        'Error',
        'Could not load the signing request. Try again from your computer.',
        false,
        logoDataUrl,
      );
    }
    const payload = (await res.json()) as {
      joyidSignUrl: string;
      preview: TxPreviewPayload | null;
    };
    if (!payload.preview) {
      // No preview provided (legacy caller) — direct 302 to JoyID.
      return Response.redirect(payload.joyidSignUrl, 302);
    }
    return previewPage(id, payload.preview, url.origin);
  };

  // Phone tapped Confirm. Clear preview state (not session) and 302
  // to JoyID so Face ID + signing can proceed. Safe to re-hit if the
  // phone double-taps — the 302 target is deterministic.
  const handleTxLaunchConfirm = async (
    env: RelayEnv,
    id: string,
  ): Promise<Response> => {
    const stub = stubFor(env, id);
    const res = await stub.fetch('https://do/launch');
    if (!res.ok) {
      const status = res.status === 410 ? 'Session expired' : 'Already used';
      const body = res.status === 410
        ? 'This signing request has already expired. Start a new one on your computer.'
        : 'This signing request has already been completed. Return to your computer.';
      return htmlPage(status, body, false, logoDataUrl);
    }
    const { joyidSignUrl } = (await res.json()) as { joyidSignUrl: string };
    return Response.redirect(joyidSignUrl, 302);
  };

  // Phone tapped Cancel. Wipe the DO so the PC's poll loop moves on
  // quickly instead of waiting the full 120s session TTL, then show
  // a reassuring splash.
  const handleTxLaunchCancel = async (
    env: RelayEnv,
    id: string,
  ): Promise<Response> => {
    const stub = stubFor(env, id);
    await stub.fetch('https://do/cancel', { method: 'POST' });
    return htmlPage(
      'Transaction cancelled',
      'Nothing was signed. Return to your computer to start a new transaction.',
      false,
      logoDataUrl,
    );
  };

  // Full-screen preview page. Inline CSS so there's zero round-trip
  // after the phone lands on us — the whole UI ships in one HTML
  // response. `100dvh` keeps the footer anchored regardless of iOS
  // Safari's URL-bar chrome. `safe-area-inset-*` respects notches.
  const previewPage = (
    id: string,
    preview: TxPreviewPayload,
    origin: string,
  ): Response => {
    const rows = preview.details
      .map(
        (row) => `
      <div class="row">
        <div class="row-label">${escapeHtml(row.label)}</div>
        <div class="row-value${row.mono ? ' mono' : ''}">${escapeHtml(row.value)}</div>
      </div>`,
      )
      .join('');

    const badge = preview.network
      ? `<span class="net ${preview.network}">${preview.network}</span>`
      : '';

    const hero = preview.amount
      ? `<div class="hero">${escapeHtml(preview.amount)}</div>`
      : '';

    const confirmHref = `${origin}/tx-launch/${encodeURIComponent(id)}/confirm`;
    const cancelHref = `${origin}/tx-launch/${encodeURIComponent(id)}/cancel`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0b0d10">
  <title>ByteRent — Confirm transaction</title>
  <style>
    :root {
      --bg: #0b0d10;
      --surface: #141820;
      --border: #1f242d;
      --fg: #e6e8eb;
      --muted: #b5bcc4;
      --dim: #8a9199;
      --accent: #0CC095;
      --danger: #ff6b6b;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100dvh; overflow: hidden; }
    body {
      background: var(--bg);
      color: var(--fg);
      font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      display: flex;
      flex-direction: column;
      padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
    }
    header {
      padding: 20px 20px 8px;
      text-align: center;
    }
    header img {
      width: 56px; height: 56px;
      filter: drop-shadow(0 0 24px rgba(12, 192, 149, 0.25));
    }
    .app-name {
      font-size: 13px;
      color: var(--dim);
      margin-top: 6px;
      letter-spacing: 0.02em;
    }
    .net {
      display: inline-block;
      margin-top: 8px;
      padding: 2px 10px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border-radius: 99px;
      border: 1px solid var(--accent);
      color: var(--accent);
    }
    main {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px 20px 16px;
      -webkit-overflow-scrolling: touch;
    }
    .title {
      text-align: center;
      color: var(--muted);
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-top: 16px;
    }
    .hero {
      text-align: center;
      font-size: 40px;
      font-weight: 700;
      color: var(--accent);
      margin: 10px 0 4px;
      letter-spacing: -0.01em;
      word-break: break-word;
    }
    .details {
      margin-top: 20px;
      background: var(--surface);
      border-radius: 12px;
      overflow: hidden;
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    }
    .row:last-child { border-bottom: 0; }
    .row-label {
      color: var(--dim);
      font-size: 13px;
      flex-shrink: 0;
    }
    .row-value {
      color: var(--fg);
      font-size: 13px;
      text-align: right;
      max-width: 60%;
      word-break: break-word;
    }
    .row-value.mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    footer {
      padding: 12px 16px 16px;
      background: var(--bg);
      border-top: 1px solid var(--border);
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      padding: 15px 16px;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.01em;
      -webkit-tap-highlight-color: transparent;
    }
    .btn.cancel {
      background: var(--surface);
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .btn.confirm {
      background: var(--accent);
      color: var(--bg);
    }
    .btn.confirm:active { filter: brightness(0.9); }
  </style>
</head>
<body>
  <header>
    <img src="/logo.png" alt="ByteRent">
    <div class="app-name">ByteRent</div>
    ${badge}
  </header>
  <main>
    <div class="title">${escapeHtml(preview.title)}</div>
    ${hero}
    <div class="details">${rows}</div>
  </main>
  <footer>
    <a class="btn cancel" href="${cancelHref}">Cancel</a>
    <a class="btn confirm" href="${confirmHref}">Confirm</a>
  </footer>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  };

  const handlePoll = async (env: RelayEnv, id: string, origin: string | null): Promise<Response> => {
    const stub = stubFor(env, id);
    const res = await stub.fetch('https://do/poll');
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  };

  const handleCallback = async (env: RelayEnv, id: string, url: URL): Promise<Response> => {
    const data = url.searchParams.get('_data_');
    const isRedirect = url.searchParams.has('joyid-redirect');

    if (!data || !isRedirect) {
      return htmlPage(
        'Error',
        'Missing JoyID redirect payload. You may have landed here by mistake.',
        false,
        logoDataUrl,
      );
    }

    const stub = stubFor(env, id);
    const res = await stub.fetch(
      `https://do/callback?_data_=${encodeURIComponent(data)}`,
      { method: 'POST' },
    );

    if (res.status === 410) {
      return htmlPage(
        'Session expired',
        'This sign-in request has already expired. Start a new one on your computer.',
        false,
        logoDataUrl,
      );
    }
    if (res.status === 409) {
      return htmlPage(
        'Already used',
        'This sign-in request has already been completed. Return to your computer.',
        false,
        logoDataUrl,
      );
    }
    if (!res.ok) {
      return htmlPage(
        'Error',
        'Something went wrong saving the sign-in. Try again from your computer.',
        false,
        logoDataUrl,
      );
    }

    return htmlPage(
      'Signed in',
      'Return to your computer — the dApp is connecting your wallet.',
      true,
      logoDataUrl,
    );
  };

  const handleLogo = (): Response => {
    if (!opts.logo) return new Response('no logo configured', { status: 404 });
    const bytes = Uint8Array.from(atob(opts.logo.base64), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        'content-type': opts.logo.contentType,
        'cache-control': 'public, max-age=31536000, immutable',
        'access-control-allow-origin': '*',
      },
    });
  };

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');

      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders(origin) });
      }

      if (url.pathname === '/session' && request.method === 'POST') {
        return handleCreate(env, origin);
      }

      if (url.pathname === '/tx-session' && request.method === 'POST') {
        return handleTxSession(env, origin, request, url);
      }

      if (url.pathname === '/logo.png' && request.method === 'GET') {
        return handleLogo();
      }

      const txLaunchConfirm = url.pathname.match(/^\/tx-launch\/([^/]+)\/confirm$/);
      if (txLaunchConfirm && request.method === 'GET') {
        return handleTxLaunchConfirm(env, txLaunchConfirm[1]);
      }

      const txLaunchCancel = url.pathname.match(/^\/tx-launch\/([^/]+)\/cancel$/);
      if (txLaunchCancel && request.method === 'GET') {
        return handleTxLaunchCancel(env, txLaunchCancel[1]);
      }

      const txLaunch = url.pathname.match(/^\/tx-launch\/([^/]+)$/);
      if (txLaunch && request.method === 'GET') {
        return handleTxLaunch(env, txLaunch[1], url);
      }

      const match = url.pathname.match(/^\/session\/([^/]+)(\/callback)?$/);
      if (match) {
        const [, sessionId, isCallback] = match;
        if (isCallback && request.method === 'GET') {
          return handleCallback(env, sessionId, url);
        }
        if (!isCallback && request.method === 'GET') {
          return handlePoll(env, sessionId, origin);
        }
      }

      return json({ error: 'not found' }, origin, 404);
    },
  };
}
