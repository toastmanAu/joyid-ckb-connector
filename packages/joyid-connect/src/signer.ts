// JoyIDRedirectSigner — a CCC Signer that connects to JoyID via the
// relay-redirect pattern instead of the popup + WebAuthn-hybrid flow.
//
// Flow:
//  1. PC asks the relay Worker for a session id (POST /session).
//  2. PC builds a JoyID URL whose redirectURL points at the Worker's
//     /session/:id/callback endpoint, and presents it as a QR.
//  3. User scans with phone camera → Safari opens testnet.joyid.dev as a
//     top-level origin → local WebAuthn + iCloud-synced passkey → Face ID.
//  4. JoyID redirects phone browser to the Worker callback with the
//     `?_data_=<base64>&joyid-redirect=true` payload.
//  5. Worker stashes the payload in its Durable Object.
//  6. PC polls /session/:id → retrieves payload → decodes with
//     @joyid/common's `decodeSearch` → AuthResponseData with address + pubkey.
//  7. Signer persists connection to localStorage and is ready to sign.
//
// Only the connect path is implemented in v0.1. Transaction signing will
// use the same redirect-relay pattern against /sign-ckb-raw-tx in v0.2.

import { ccc } from '@ckb-ccc/core';
import { decodeSearch, buildJoyIDURL } from '@joyid/common';
import type { RelayClient } from './worker';
import { resolveJoyIDAppUrl, type JoyIDNetwork } from './config';

const DEFAULT_STORAGE_KEY = 'joyid-connect.connection';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

export interface PersistedConnection {
  address: string;
  publicKey: string;
  keyType: string;
}

export interface SessionHandle {
  sessionId: string;
  qrPayloadUrl: string;
  ready: Promise<PersistedConnection>;
  cancel: () => void;
}

export interface BeginConnectOptions {
  appName: string;
  appIcon: string;
  network: JoyIDNetwork;
  /** Optional override — defaults to testnet.joyid.dev or app.joy.id based on network. */
  joyidAppUrl?: string;
  relay: RelayClient;
}

/**
 * Kick off a connect session. Returns the QR payload to render and a
 * promise that resolves when the phone completes. Separated from the
 * Signer class so UIs can show the QR modal while polling runs.
 */
export async function beginJoyIDConnect(
  opts: BeginConnectOptions,
): Promise<SessionHandle> {
  const { id: sessionId } = await opts.relay.createSession();

  const joyidAppUrl = opts.joyidAppUrl ?? resolveJoyIDAppUrl(opts.network);

  const qrPayloadUrl = buildJoyIDURL(
    {
      redirectURL: opts.relay.callbackUrl(sessionId),
      name: opts.appName,
      logo: opts.appIcon,
      joyidAppURL: joyidAppUrl,
    },
    'redirect',
    '/auth',
  );

  let cancelled = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const ready = new Promise<PersistedConnection>((resolve, reject) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };

    pollTimer = setInterval(async () => {
      if (cancelled) {
        cleanup();
        reject(new Error('Connect cancelled'));
        return;
      }
      if (Date.now() > deadline) {
        cleanup();
        reject(new Error('Connect timed out — no response from phone'));
        return;
      }

      try {
        const res = await opts.relay.pollSession(sessionId);
        if (res.expired) {
          cleanup();
          reject(new Error('Session expired'));
          return;
        }
        if (res.data) {
          cleanup();
          // `_data_` is a base64url-encoded JSON blob. decodeSearch
          // handles both the encoding and unwraps the JoyID response
          // envelope ({ data, error?, state? }).
          const decoded = decodeSearch(res.data) as {
            data?: { address?: string; pubkey?: string; keyType?: string };
            error?: string;
          };
          if (decoded.error) {
            reject(new Error(`JoyID error: ${decoded.error}`));
            return;
          }
          const payload = decoded.data;
          if (!payload?.address || !payload.pubkey) {
            reject(new Error('JoyID response missing address/pubkey'));
            return;
          }
          resolve({
            address: payload.address,
            publicKey: payload.pubkey,
            keyType: payload.keyType ?? 'main_key',
          });
        }
      } catch {
        // Transient fetch errors — keep polling until the deadline.
        // Only terminal errors (expired, malformed payload) tear down early.
      }
    }, POLL_INTERVAL_MS);
  });

  return {
    sessionId,
    qrPayloadUrl,
    ready,
    cancel: () => {
      cancelled = true;
    },
  };
}

export interface JoyIDRedirectSignerOpts {
  appName: string;
  appIcon: string;
  network: JoyIDNetwork;
  /** Optional override — defaults to testnet.joyid.dev or app.joy.id based on network. */
  joyidAppUrl?: string;
  /** localStorage key used to persist the wallet connection across reloads. */
  storageKey?: string;
  /**
   * Called when the Signer's `connect()` is invoked (e.g. by the CCC modal).
   * Consumer is expected to drive the QR UX, call beginJoyIDConnect(), and
   * resolve with the final PersistedConnection when the phone completes.
   */
  onConnectIntent: () => Promise<PersistedConnection>;
}

/**
 * CCC Signer backed by a persisted JoyID connection. The heavy lifting
 * happens in the consumer's `onConnectIntent` (which usually calls
 * `beginJoyIDConnect` and shows a QR modal); this class is a thin adapter
 * that plugs into the CCC picker + `useSigner()` hook.
 */
export class JoyIDRedirectSigner extends ccc.Signer {
  private connection?: PersistedConnection;
  private readonly opts: JoyIDRedirectSignerOpts;
  private readonly storageKey: string;

  constructor(client: ccc.Client, opts: JoyIDRedirectSignerOpts) {
    super(client);
    this.opts = opts;
    this.storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY;
  }

  get type(): ccc.SignerType {
    return ccc.SignerType.CKB;
  }

  get signType(): ccc.SignerSignType {
    return ccc.SignerSignType.JoyId;
  }

  async connect(): Promise<void> {
    this.connection = await this.opts.onConnectIntent();
    window.localStorage.setItem(this.storageKey, JSON.stringify(this.connection));
  }

  async disconnect(): Promise<void> {
    this.connection = undefined;
    window.localStorage.removeItem(this.storageKey);
  }

  async isConnected(): Promise<boolean> {
    if (this.connection) return true;
    const raw = window.localStorage.getItem(this.storageKey);
    if (!raw) return false;
    try {
      this.connection = JSON.parse(raw) as PersistedConnection;
      return true;
    } catch {
      window.localStorage.removeItem(this.storageKey);
      return false;
    }
  }

  private assertConnection(): PersistedConnection {
    if (!this.connection) {
      throw new Error('JoyIDRedirectSigner: not connected');
    }
    return this.connection;
  }

  async getInternalAddress(): Promise<string> {
    return this.assertConnection().address;
  }

  async getIdentity(): Promise<string> {
    const c = this.assertConnection();
    return JSON.stringify({
      keyType: c.keyType,
      publicKey: c.publicKey.replace(/^0x/, ''),
    });
  }

  async getAddressObj(): Promise<ccc.Address> {
    return ccc.Address.fromString(await this.getInternalAddress(), this.client);
  }

  async getAddressObjs(): Promise<ccc.Address[]> {
    return [await this.getAddressObj()];
  }

  // Transaction signing will arrive in v0.2 via the same Worker-relay
  // pattern. Explicitly unsupported so callers see a clear error instead
  // of a silent bad-tx.
  async signOnlyTransaction(): Promise<ccc.Transaction> {
    throw new Error(
      '@byterent/joyid-connect: transaction signing via redirect-relay is not yet implemented (v0.2 work).',
    );
  }
}
