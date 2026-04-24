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

export interface SignIntentPayload {
  /**
   * Prepared ccc.Transaction — witness[0] is already trimmed by the
   * signer. The provider/UX layer should NOT re-prepare; it just
   * needs to call beginJoyIDSign with this tx + the metadata below.
   */
  tx: ccc.Transaction;
  witnessIndexes: number[];
  signerAddress: string;
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
  /**
   * Called when the Signer's `signOnlyTransaction()` is invoked. Consumer
   * drives the QR UX (typically via `beginJoyIDSign`), resolves with the
   * signed `ccc.Transaction`. Optional — omit if your dApp only needs
   * wallet connect and never signs transactions.
   */
  onSignIntent?: (payload: SignIntentPayload) => Promise<ccc.Transaction>;
}

export interface BeginSignOptions {
  tx: ccc.Transaction;
  witnessIndexes: number[];
  signerAddress: string;
  appName: string;
  appIcon: string;
  network: JoyIDNetwork;
  /** Optional override — defaults to testnet.joyid.dev or app.joy.id based on network. */
  joyidAppUrl?: string;
  relay: RelayClient;
}

export interface SignSessionHandle {
  sessionId: string;
  /**
   * Short URL the PC renders as QR. Phone scans → Worker 302s to the
   * full JoyID /sign-ckb-raw-tx URL. Unlike connect's `qrPayloadUrl`,
   * this is always ~70 bytes regardless of tx size.
   */
  launchUrl: string;
  ready: Promise<ccc.Transaction>;
  cancel: () => void;
}

/**
 * Kick off a sign session. The tx is POSTed to the relay Worker
 * (base64url-encoded inside a JoyID URL), phone scans the short
 * launchUrl, Worker redirects to JoyID, user approves, JoyID posts
 * back to /session/:id/callback, PC polls and gets the signed tx.
 *
 * Caller is responsible for having completed the tx (inputs, outputs,
 * fee) BEFORE handing it to this function — see ckb-transactions.md §1.
 * The signer method on `JoyIDRedirectSigner` takes care of witness[0]
 * trimming before calling this helper.
 */
export async function beginJoyIDSign(
  opts: BeginSignOptions,
): Promise<SignSessionHandle> {
  const joyidAppUrl = opts.joyidAppUrl ?? resolveJoyIDAppUrl(opts.network);

  // Mint the session id client-side so we can bake the callback URL
  // into the JoyID payload before handing it to the relay.
  const sessionId = globalThis.crypto.randomUUID();

  // `tx.stringify()` serialises CCC's Transaction to the JSON-RPC
  // camelCase shape JoyID's /sign-ckb-raw-tx endpoint expects.
  // We re-parse to a plain object because buildJoyIDURL JSON-encodes
  // the whole request into `_data_`, and double-stringifying produces
  // an escaped string instead of an object.
  const txJson = JSON.parse(opts.tx.stringify()) as unknown;

  const joyidSignUrl = buildJoyIDURL(
    {
      redirectURL: opts.relay.callbackUrl(sessionId),
      name: opts.appName,
      logo: opts.appIcon,
      joyidAppURL: joyidAppUrl,
      tx: txJson,
      signerAddress: opts.signerAddress,
      witnessIndexes: opts.witnessIndexes,
    } as Parameters<typeof buildJoyIDURL>[0],
    'redirect',
    '/sign-ckb-raw-tx',
  );

  const { launchUrl } = await opts.relay.createTxSession(joyidSignUrl, sessionId);

  let cancelled = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const ready = new Promise<ccc.Transaction>((resolve, reject) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };

    pollTimer = setInterval(async () => {
      if (cancelled) {
        cleanup();
        reject(new Error('Sign cancelled'));
        return;
      }
      if (Date.now() > deadline) {
        cleanup();
        reject(new Error('Sign timed out — no response from phone'));
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
          const decoded = decodeSearch(res.data) as {
            data?: { tx?: unknown };
            error?: string;
          };
          if (decoded.error) {
            reject(new Error(`JoyID error: ${decoded.error}`));
            return;
          }
          if (!decoded.data?.tx) {
            reject(new Error('JoyID response missing signed tx'));
            return;
          }
          try {
            const signed = ccc.Transaction.from(
              decoded.data.tx as ccc.TransactionLike,
            );
            resolve(signed);
          } catch (parseErr) {
            reject(
              new Error(
                `Failed to parse signed tx: ${
                  parseErr instanceof Error ? parseErr.message : String(parseErr)
                }`,
              ),
            );
          }
        }
      } catch {
        // Transient fetch errors — keep polling until the deadline.
      }
    }, POLL_INTERVAL_MS);
  });

  return {
    sessionId,
    launchUrl,
    ready,
    cancel: () => {
      cancelled = true;
    },
  };
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

  // Transaction signing via the same relay pattern as connect, now
  // routing through /tx-session + /tx-launch so the QR is short
  // regardless of tx size.
  //
  // Contract with the caller (see ckb-transactions.md §1): the tx must
  // already have inputs collected, outputs finalised, and fee completed
  // BEFORE calling this. We pad witness[0] down to an empty WitnessArgs
  // envelope before sending to JoyID (shrinks URL, JoyID-side signing
  // expands back). `cellOutput` / `outputData` on inputs are stripped
  // for the same reason.
  async signOnlyTransaction(
    txLike: ccc.TransactionLike,
  ): Promise<ccc.Transaction> {
    if (!this.opts.onSignIntent) {
      throw new Error(
        '@byterent/joyid-connect: no onSignIntent registered. ' +
          'Mount <JoyIDConnectProvider> with sign support, or pass onSignIntent directly.',
      );
    }

    const tx = ccc.Transaction.from(txLike);
    const { script } = await this.getAddressObj();

    // Positions of inputs owned by the user's JoyID lock — JoyID
    // needs these to know which witnesses it's populating.
    const witnessIndexes: number[] = [];
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const { cellOutput } = await input.getCell(this.client);
      if (cellOutput.lock.eq(script)) {
        witnessIndexes.push(i);
      }
    }

    // Trim witness[0] to an empty lock. Matches the official CCC
    // JoyID signer — JoyID's server expands back to a real signature.
    await tx.prepareSighashAllWitness(script, 0, this.client);

    // Shrink the URL payload by stripping CCC's denormalisation hints.
    tx.inputs.forEach((i) => {
      i.cellOutput = undefined;
      i.outputData = undefined;
    });

    const signerAddress = await this.getInternalAddress();

    return this.opts.onSignIntent({
      tx,
      witnessIndexes,
      signerAddress,
    });
  }
}
