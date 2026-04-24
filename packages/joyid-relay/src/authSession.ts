// One Durable Object instance per session id (via
// env.AUTH_SESSION.idFromName(sessionId)). Both the phone (via
// /session/:id/callback) and the PC (via /session/:id poll) hit the
// SAME runtime, so writes are immediately visible — strong consistency,
// no KV/POP lag.
//
// Sessions support two use cases:
//   - CONNECT: PC opens session → phone scans JoyID auth URL directly →
//     JoyID redirects to /callback → PC polls.
//   - SIGN (tx):  PC arms the session with a pre-built JoyID
//     /sign-ckb-raw-tx URL → PC shows a SHORT launchUrl as QR → phone
//     scans → Worker 302s to the armed JoyID URL → JoyID redirects to
//     /callback → PC polls.
//
// The callback + poll half is identical for both — only /arm + /launch
// are sign-specific.

const SESSION_TTL_MS = 120_000;

type SessionState = 'waiting' | 'ready';

export class AuthSession {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/create':
        return this.create();
      case '/arm':
        return this.arm(request);
      case '/launch':
        return this.launch();
      case '/callback':
        return this.callback(url.searchParams.get('_data_') ?? '');
      case '/poll':
        return this.poll();
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async create(): Promise<Response> {
    await this.state.storage.put('state', 'waiting' as SessionState);
    await this.state.storage.setAlarm(Date.now() + SESSION_TTL_MS);
    return new Response(null, { status: 204 });
  }

  // Store a pre-built JoyID sign URL so /launch can redirect to it.
  // Must come after /create. Only permitted once — a second /arm on the
  // same session is an error, since arming after the phone has already
  // redirected would leak a half-consumed state.
  private async arm(request: Request): Promise<Response> {
    const current = await this.state.storage.get<SessionState>('state');
    if (current === undefined) {
      return jsonResponse({ ok: false, reason: 'expired' }, 410);
    }
    if (current !== 'waiting') {
      return jsonResponse({ ok: false, reason: 'already_used' }, 409);
    }
    const existing = await this.state.storage.get<string>('armedUrl');
    if (existing !== undefined) {
      return jsonResponse({ ok: false, reason: 'already_armed' }, 409);
    }
    const { joyidSignUrl } = (await request.json()) as { joyidSignUrl?: string };
    if (!joyidSignUrl || typeof joyidSignUrl !== 'string') {
      return jsonResponse({ ok: false, reason: 'missing_url' }, 400);
    }
    await this.state.storage.put('armedUrl', joyidSignUrl);
    return new Response(null, { status: 204 });
  }

  // Phone hits /tx-launch/:id → Worker calls this → returns the armed
  // JoyID URL so the Worker can 302 the phone. Repeatable: a phone that
  // loses its redirect mid-flow can re-scan the QR and try again, as
  // long as /callback hasn't fired yet.
  private async launch(): Promise<Response> {
    const current = await this.state.storage.get<SessionState>('state');
    if (current === undefined) {
      return jsonResponse({ ok: false, reason: 'expired' }, 410);
    }
    if (current !== 'waiting') {
      return jsonResponse({ ok: false, reason: 'already_used' }, 409);
    }
    const armedUrl = await this.state.storage.get<string>('armedUrl');
    if (armedUrl === undefined) {
      return jsonResponse({ ok: false, reason: 'not_armed' }, 409);
    }
    return jsonResponse({ joyidSignUrl: armedUrl });
  }

  private async callback(data: string): Promise<Response> {
    if (!data) {
      return jsonResponse({ ok: false, reason: 'missing' }, 400);
    }
    const current = await this.state.storage.get<SessionState>('state');
    if (current === undefined) {
      return jsonResponse({ ok: false, reason: 'expired' }, 410);
    }
    if (current !== 'waiting') {
      return jsonResponse({ ok: false, reason: 'already_used' }, 409);
    }
    await this.state.storage.put('state', 'ready' as SessionState);
    await this.state.storage.put('data', data);
    // `armedUrl` can be cleared now — the phone is past it.
    await this.state.storage.delete('armedUrl');
    return new Response(null, { status: 204 });
  }

  private async poll(): Promise<Response> {
    const current = await this.state.storage.get<SessionState>('state');
    if (current === undefined) {
      return jsonResponse({ data: null, expired: true }, 410);
    }
    if (current === 'ready') {
      const data = await this.state.storage.get<string>('data');
      // One-time consumption — replay polls return 410.
      await this.state.storage.deleteAll();
      return jsonResponse({ data, expired: false });
    }
    return jsonResponse({ data: null, expired: false });
  }

  async alarm(): Promise<void> {
    // Session lifetime elapsed. Clear storage so subsequent polls 410.
    await this.state.storage.deleteAll();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
