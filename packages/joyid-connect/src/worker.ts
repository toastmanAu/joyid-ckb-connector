// Thin client for a joyid-relay Worker. The Worker URL is injected — the
// library has no default, no hardcoded domain, no ByteRent-specific assumption.

/**
 * Structured preview shown on the Worker's phone-side confirmation
 * page. Kept in the worker module so both the relay client and the
 * library consumers can share the shape.
 */
export interface TxPreviewPayload {
  title: string;
  amount?: string;
  details: Array<{ label: string; value: string; mono?: boolean }>;
  network?: 'testnet' | 'mainnet';
}

export interface RelayClient {
  createSession(): Promise<CreateSessionResponse>;
  /**
   * Create a signing session. Caller mints the id (so it can bake the
   * redirectURL into the JoyID URL before POSTing) and optionally
   * supplies a preview payload to show on the phone confirmation page.
   */
  createTxSession(
    joyidSignUrl: string,
    id: string,
    preview?: TxPreviewPayload,
  ): Promise<CreateTxSessionResponse>;
  pollSession(id: string): Promise<PollResponse>;
  callbackUrl(sessionId: string): string;
}

export interface CreateSessionResponse {
  id: string;
  ttl: number;
}

export interface CreateTxSessionResponse {
  id: string;
  /**
   * Short URL the PC renders as QR. When the phone scans and follows it,
   * the relay Worker 302s to the stored JoyID /sign-ckb-raw-tx URL.
   * Lets us show a ~70-byte QR for an arbitrary-size tx payload.
   */
  launchUrl: string;
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

    async createTxSession(
      joyidSignUrl: string,
      id: string,
      preview?: TxPreviewPayload,
    ): Promise<CreateTxSessionResponse> {
      const res = await fetch(`${base}/tx-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, joyidSignUrl, preview }),
      });
      if (!res.ok) {
        throw new Error(`joyid-relay tx-session create failed: ${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<CreateTxSessionResponse>;
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
