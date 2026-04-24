// Worker routing layer. Consumers compose an ExportedHandler via
// makeRelayWorker(opts) and re-export AuthSession as the DO class.

import type { RelayEnv } from './env';

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
  // shows as QR — scanning it lands on /tx-launch/:id which 302s to the
  // stored JoyID `/sign-ckb-raw-tx` URL. Avoids pushing multi-KB tx
  // payloads through a QR directly.
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
    let body: { id?: string; joyidSignUrl?: string };
    try {
      body = (await request.json()) as { id?: string; joyidSignUrl?: string };
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
      body: JSON.stringify({ joyidSignUrl: body.joyidSignUrl }),
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

  // Phone lands here via QR scan. Fetch the armed JoyID URL and 302.
  // No CORS — this is a top-level navigation, not a fetch.
  const handleTxLaunch = async (env: RelayEnv, id: string): Promise<Response> => {
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
    const { joyidSignUrl } = (await res.json()) as { joyidSignUrl: string };
    return Response.redirect(joyidSignUrl, 302);
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

      const txLaunch = url.pathname.match(/^\/tx-launch\/([^/]+)$/);
      if (txLaunch && request.method === 'GET') {
        return handleTxLaunch(env, txLaunch[1]);
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
