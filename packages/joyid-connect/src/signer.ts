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
import {
  decodeSearch,
  buildJoyIDURL,
  buildJoyIDSignMessageURL,
  base64urlToHex,
} from '@joyid/common';
import { calculateChallenge, buildSignedTx } from '@joyid/ckb';
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
 * Kick off a sign session.
 *
 * JoyID's `/sign-ckb-raw-tx` endpoint hard-codes popup communication —
 * `type=redirect` is ignored, the page errors at load with "window closed"
 * because it can't find `window.opener`. Only `/auth` and `/sign-message`
 * actually support redirect.
 *
 * So we pivot: compute the CKB sighash challenge client-side (same hash
 * the on-chain JoyID lock script validates), ask JoyID to sign *that*
 * via `/sign-message?type=redirect`, then assemble the final witness
 * ourselves using `@joyid/ckb`'s `buildSignedTx`.
 *
 * Caller is responsible for having completed the tx (inputs, outputs,
 * fee, witness[0] placeholder) BEFORE handing it to this function —
 * see ckb-transactions.md §1. We don't mutate the tx's witness sizes;
 * calculateChallenge handles the 129-byte empty-lock internally.
 */
export async function beginJoyIDSign(
  opts: BeginSignOptions,
): Promise<SignSessionHandle> {
  const joyidAppUrl = opts.joyidAppUrl ?? resolveJoyIDAppUrl(opts.network);

  // Mint the session id client-side so we can bake the callback URL
  // into the JoyID payload before handing it to the relay.
  const sessionId = globalThis.crypto.randomUUID();

  // `tx.stringify()` serialises CCC's Transaction to the JSON-RPC
  // camelCase shape `@joyid/ckb` expects. Re-parse to a plain object
  // so calculateChallenge can read it + buildSignedTx can mutate it.
  const ckbTx = JSON.parse(opts.tx.stringify()) as Parameters<
    typeof calculateChallenge
  >[0];

  // Defensive witness padding: `calculateChallenge` refuses to run
  // with an empty witnesses array or non-string slots, so guarantee
  // a serialized WitnessArgs placeholder exists at every position we
  // plan to sign at. Belt-and-suspenders in case CCC's
  // completeFeeBy → prepareTransaction pipeline didn't propagate our
  // earlier padding (e.g. a change-iteration clone path). The exact
  // value doesn't matter — calculateChallenge internally serializes
  // witness[position] with a fresh 129-byte empty lock for hashing.
  const emptyWitnessArgs = ccc.hexFrom(
    ccc.WitnessArgs.from({ lock: '0x' + '00'.repeat(1000) }).toBytes(),
  );
  if (!Array.isArray(ckbTx.witnesses)) ckbTx.witnesses = [];
  for (const idx of opts.witnessIndexes) {
    while (ckbTx.witnesses.length <= idx) ckbTx.witnesses.push('0x');
    if (
      typeof ckbTx.witnesses[idx] !== 'string' ||
      ckbTx.witnesses[idx] === '0x'
    ) {
      ckbTx.witnesses[idx] = emptyWitnessArgs;
    }
  }

  // Compute the sighash JoyID will be asked to sign. witnessIndexes MUST
  // cover every input in the user's lock group — the on-chain script
  // hashes all of them, not just witness[0]. Default `[0]` is wrong
  // for multi-input txs.
  const challenge = await calculateChallenge(ckbTx, opts.witnessIndexes);

  const joyidSignUrl = buildJoyIDSignMessageURL(
    {
      redirectURL: opts.relay.callbackUrl(sessionId),
      name: opts.appName,
      logo: opts.appIcon,
      joyidAppURL: joyidAppUrl,
      challenge,
      isData: false,
      address: opts.signerAddress,
    } as Parameters<typeof buildJoyIDSignMessageURL>[0],
    'redirect',
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
            data?: {
              signature?: string;
              message?: string;
              pubkey?: string;
              keyType?: string;
              alg?: number;
            };
            error?: string;
          };
          if (decoded.error) {
            reject(new Error(`JoyID error: ${decoded.error}`));
            return;
          }
          const payload = decoded.data;
          if (!payload?.signature || !payload.pubkey || !payload.message) {
            reject(new Error('JoyID response missing signature/pubkey/message'));
            return;
          }
          try {
            const signedTx = assembleSignedTx(
              ckbTx,
              {
                signature: payload.signature,
                message: payload.message,
                pubkey: payload.pubkey,
                keyType: payload.keyType,
                alg: payload.alg,
              },
              opts.witnessIndexes,
            );
            resolve(ccc.Transaction.from(signedTx as ccc.TransactionLike));
          } catch (asmErr) {
            reject(
              new Error(
                `Failed to assemble signed tx: ${
                  asmErr instanceof Error ? asmErr.message : String(asmErr)
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
 * Normalise the redirect-flow sign-message response and assemble the
 * final signed witness via @joyid/ckb's buildSignedTx.
 *
 * Redirect-mode responses differ from popup responses in two annoying
 * ways that have to be unwound before buildSignedTx accepts them:
 *   - `signature` and `message` arrive as base64url, not hex.
 *   - `signature` is DER-encoded ECDSA (from the raw WebAuthn
 *     credential), but the on-chain lock expects IEEE P1363 (r‖s,
 *     fixed 64 bytes). Popup flow does this conversion on JoyID's
 *     servers before returning — redirect flow skips it.
 *
 * Reference: ~/fiberquest/src/agent-wallet.js :: assembleSignedTx —
 * proven against mainnet + testnet since the FiberQuest tournament
 * launch. Ported here to keep the library self-contained.
 */
function assembleSignedTx(
  unsignedCkbTx: Parameters<typeof buildSignedTx>[0],
  payload: {
    signature: string;
    message: string;
    pubkey: string;
    keyType?: string;
    alg?: number;
  },
  witnessIndexes: number[],
): ReturnType<typeof buildSignedTx> {
  const isHex = (s: string): boolean => /^(0x)?[0-9a-f]*$/i.test(s);

  let signature = isHex(payload.signature)
    ? payload.signature
    : base64urlToHex(payload.signature);
  let message = isHex(payload.message)
    ? payload.message
    : base64urlToHex(payload.message);
  let pubkey = payload.pubkey;

  if (pubkey.startsWith('0x')) pubkey = pubkey.slice(2);
  if (signature.startsWith('0x')) signature = signature.slice(2);
  if (message.startsWith('0x')) message = message.slice(2);

  // DER → IEEE P1363. IEEE is exactly 128 hex chars (64 bytes: r‖s).
  // DER layout: 30 LEN 02 rLen r 02 sLen s — length varies by leading
  // sign bits. Trim or zero-pad r and s to 32 bytes each.
  if (signature.length !== 128) {
    const derBytes = hexToUint8Array(signature);
    const rLen = derBytes[3];
    const rStart = 4;
    const rEnd = rStart + rLen;
    const sLen = derBytes[rEnd + 1];
    const sStart = rEnd + 2;
    const sEnd = sStart + sLen;
    let r = uint8ArrayToHex(derBytes.subarray(rStart, rEnd));
    let s = uint8ArrayToHex(derBytes.subarray(sStart, sEnd));
    r = r.length > 64 ? r.slice(-64) : r.padStart(64, '0');
    s = s.length > 64 ? s.slice(-64) : s.padStart(64, '0');
    signature = r + s;
  }

  const normalized = {
    signature,
    message,
    pubkey,
    keyType: payload.keyType ?? 'main_key',
    alg: payload.alg,
  } as Parameters<typeof buildSignedTx>[1];

  return buildSignedTx(unsignedCkbTx, normalized, witnessIndexes);
}

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
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

  /**
   * CCC's `completeFeeBy` calls this before estimating fees; by
   * convention it's also the point where a signer attaches any
   * cell_deps its lock script needs and reserves witness space for
   * the eventual signature. Matches what the official CCC JoyID
   * signer does (see @ckb-ccc/joy-id/dist/ckb/index.js) — without
   * this, the tx reaches the pool but fails script execution with
   * `ScriptNotFound` because the JoyID lock code isn't in cell_deps.
   *
   * Subkey (COTA) wallets aren't supported by this redirect signer
   * yet — we deferred that path day-1 since it needs an aggregator.
   */
  async prepareTransaction(
    txLike: ccc.TransactionLike,
  ): Promise<ccc.Transaction> {
    // eslint-disable-next-line no-console
    console.log('[JoyIDRedirectSigner.prepareTransaction] called, tx inputs:',
      (txLike as ccc.Transaction).inputs?.length,
      'witnesses:', (txLike as ccc.Transaction).witnesses?.length);
    const tx = ccc.Transaction.from(txLike);
    await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.JoyId);

    // Reserve witness[0] space sized for JoyID's signed lock
    // (~161 bytes but match the official signer's 1000-byte reservation
    // for fee safety — see ckb-transactions.md §1). CCC's
    // `findInputIndexByLock` + `getWitnessArgsAt` handle the case
    // where inputs[0] isn't our lock (mixed-lock txs).
    const lockScript = (await this.getAddressObj()).script;
    const position = await tx.findInputIndexByLock(lockScript, this.client);
    // eslint-disable-next-line no-console
    console.log('[JoyIDRedirectSigner.prepareTransaction] position:', position);
    if (position === undefined) return tx;

    const witness = tx.getWitnessArgsAt(position) ?? ccc.WitnessArgs.from({});
    witness.lock = ccc.hexFrom('00'.repeat(1000));
    tx.setWitnessArgsAt(position, witness);
    // eslint-disable-next-line no-console
    console.log('[JoyIDRedirectSigner.prepareTransaction] after set, witnesses:', tx.witnesses.length);
    return tx;
  }

  // Transaction signing via the redirect-relay pattern. Because JoyID's
  // /sign-ckb-raw-tx endpoint breaks redirect mode (see beginJoyIDSign
  // comment), we use /sign-message instead: compute the sighash
  // client-side via `calculateChallenge`, JoyID signs the hash, we
  // assemble the witness ourselves via `buildSignedTx`.
  //
  // Contract with the caller (ckb-transactions.md §1): the tx must
  // already have inputs collected, outputs finalised, and fee completed
  // BEFORE calling this. We preserve the caller's witness[0]
  // placeholder (typically ~1000-byte lock) — calculateChallenge
  // rewrites it to a 129-byte empty-lock internally for the hash, so
  // our stored size doesn't affect sighash.
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

    // Positions of inputs owned by the user's JoyID lock. The on-chain
    // JoyID lock script hashes EVERY witness in its group when
    // validating, so we need them all — not just [0]. FiberQuest
    // uses `inputs.map((_, i) => i)` which works when all inputs share
    // one lock; we compute per-input to handle mixed-lock txs safely.
    const witnessIndexes: number[] = [];
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];
      const { cellOutput } = await input.getCell(this.client);
      if (cellOutput.lock.eq(script)) {
        witnessIndexes.push(i);
      }
    }

    if (witnessIndexes.length === 0) {
      throw new Error(
        'JoyIDRedirectSigner: no JoyID-locked inputs found — tx cannot be signed by this connection',
      );
    }

    // eslint-disable-next-line no-console
    console.log('[JoyIDRedirectSigner.signOnlyTransaction] inputs:', tx.inputs.length,
      'witnesses:', tx.witnesses.length, 'witnessIndexes:', witnessIndexes);

    const signerAddress = await this.getInternalAddress();

    return this.opts.onSignIntent({
      tx,
      witnessIndexes,
      signerAddress,
    });
  }
}
