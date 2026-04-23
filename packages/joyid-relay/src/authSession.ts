// One Durable Object instance per session id (via
// env.AUTH_SESSION.idFromName(sessionId)). Both the phone (via
// /session/:id/callback) and the PC (via /session/:id poll) hit the
// SAME runtime, so writes are immediately visible — strong consistency,
// no KV/POP lag.

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
