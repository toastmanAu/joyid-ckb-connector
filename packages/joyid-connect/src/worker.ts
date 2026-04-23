// Thin client for a joyid-relay Worker. The Worker URL is injected — the
// library has no default, no hardcoded domain, no ByteRent-specific assumption.

export interface RelayClient {
  createSession(): Promise<CreateSessionResponse>;
  pollSession(id: string): Promise<PollResponse>;
  callbackUrl(sessionId: string): string;
}

export interface CreateSessionResponse {
  id: string;
  ttl: number;
}

export interface PollResponse {
  data: string | null;
  expired: boolean;
}

export function createRelayClient(workerUrl: string): RelayClient {
  const base = workerUrl.replace(/\/$/, '');

  return {
    async createSession(): Promise<CreateSessionResponse> {
      const res = await fetch(`${base}/session`, { method: 'POST' });
      if (!res.ok) {
        throw new Error(`joyid-relay session create failed: ${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<CreateSessionResponse>;
    },

    async pollSession(id: string): Promise<PollResponse> {
      const res = await fetch(`${base}/session/${encodeURIComponent(id)}`);
      // 410 Gone is a terminal "expired" signal — it carries a JSON body too.
      if (!res.ok && res.status !== 410) {
        throw new Error(`joyid-relay poll failed: ${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<PollResponse>;
    },

    callbackUrl(sessionId: string): string {
      return `${base}/session/${encodeURIComponent(sessionId)}/callback`;
    },
  };
}
