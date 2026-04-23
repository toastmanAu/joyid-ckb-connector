# joyid-ckb-connector

A mobile-first JoyID connector for CKB dApps. Solves the "my desktop
Chrome can't talk to my iPhone's passkey" problem by bypassing Chrome's
WebAuthn hybrid (caBLE) transport entirely and relaying the phone's
local auth result through a tiny Cloudflare Worker.

**Two packages, one coherent flow:**

| Package | What it is |
|---|---|
| [`@byterent/joyid-connect`](./packages/joyid-connect) | Frontend: a CCC `Signer` + React `<JoyIDConnectProvider>` + QR modal. Drop into any CCC-based dApp. |
| [`@byterent/joyid-relay`](./packages/joyid-relay) | Backend: a Cloudflare Worker + Durable Object that brokers the phone→PC auth handshake. Deploy your own, point the frontend at it. |

## The problem this solves

CCC's default JoyID connector opens a popup to `testnet.joyid.dev/auth`
which calls `navigator.credentials.get({publicKey})`. On desktop without
a local platform passkey, Chrome falls back to its **FIDO hybrid
transport** — the `FIDO:/...` QR + Bluetooth pairing + cloud relay. That
flow is notoriously unreliable on Linux and frequently times out even on
macOS/Windows.

This connector never triggers WebAuthn on the PC. Instead it shows a QR
containing a JoyID URL, the user scans with their iPhone camera, Safari
opens `testnet.joyid.dev` as a **top-level origin**, local WebAuthn runs
against the iCloud-synced JoyID passkey (Face ID / Touch ID, no
Bluetooth), and the result is relayed back to the PC via a stateful
Durable Object.

See [the flow docs in packages/joyid-connect](./packages/joyid-connect/README.md)
for details.

## Quick start

```bash
# 1. Deploy your own relay Worker (see packages/joyid-relay README)
cd packages/joyid-relay/example
npm install && npx wrangler login
npx wrangler kv namespace create SESSIONS  # note: not needed with DO variant
npx wrangler deploy

# 2. Install the library in your dApp
cd your-dapp
npm install @byterent/joyid-connect

# 3. Wire it up (see packages/joyid-connect README)
```

## Status

- v0.1: Auth (connect) implemented
- v0.2 (planned): Transaction signing via the same redirect-relay pattern

## Why "byterent" in the package scope?

This was extracted from [ByteRent](https://byterent.xyz)'s custom
connector. The scope is a placeholder while the package finds its home —
happy to re-scope under `@ckb-community`, `@nervos`, or similar before
v1.0.

## License

MIT
