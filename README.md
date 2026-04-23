# joyid-ckb-connector

> Mobile-first JoyID connector for CKB dApps. Sidesteps Chrome's flaky
> WebAuthn hybrid transport by relaying the phone's local auth result
> through a tiny Cloudflare Worker.

[![Status](https://img.shields.io/badge/status-v0.1%20alpha-orange)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

## The problem

If you've shipped a CKB web dApp that uses JoyID on desktop Chrome, you
already know the failure mode: user clicks "Connect", a popup opens to
`testnet.joyid.dev/auth?type=popup`, and Chrome shows a **FIDO hybrid
transport QR** (`FIDO:/...`) demanding Bluetooth pairing between PC
and phone plus a cloud relay handshake. On Linux it almost never
works. On macOS/Windows it's a coin-flip. There's no JoyID bug here —
the broken step is Chrome's cross-device WebAuthn layer.

The standard `@ckb-ccc/joy-id` connector builds on that popup flow, so
every CCC-based dApp inherits the same fragility. This project fixes
it by **never calling `navigator.credentials.get()` on the PC at all**.

## How it works

```
      PC (desktop browser)                     Phone (iPhone + Safari)
      ──────────────────────                   ───────────────────────

  1. Click "Connect JoyID"
         │
  2. POST /session  ─────────►   Cloudflare Worker (Durable Object)
                                       │
                                       ▼
  3. ◄── { id: uuid }         spawns a DO instance, 120s alarm
         │
  4. Render QR encoding
     testnet.joyid.dev/?...
     &redirectURL=<worker>/
     session/:id/callback
         │                                       ┌──────────────────┐
         │                                       │  iPhone camera   │
         │            (user scans QR)            │  opens URL in    │
         ├───────────────────────────────────►   │  Safari          │
         │                                       └──────────────────┘
         │                                                │
         │                                       5. WebAuthn runs
         │                                          LOCALLY against
         │                                          iCloud-synced
         │                                          JoyID passkey
         │                                          (Face ID / Touch ID)
         │                                                │
         │                            6. JoyID redirects phone to:
         │                               <worker>/session/:id/callback
         │                               ?_data_=<base64>&joyid-redirect=true
         │                                                │
         │                                                ▼
  7. GET /session/:id          ◄──── Worker stores payload in DO
     (poll every 2s)                                  │
         │                                            │
  8. ◄── { data: <payload> }  ◄─── DO serves poll     │
         │                        (strong consistency)│
         │                                            ▼
  9. decode with @joyid/                      Show "Signed in — return
     common.decodeSearch(),                    to your computer" page
     persist to localStorage,
     connected ✓
```

The key architectural move is step 5. The iPhone is the top-level
origin when testnet.joyid.dev loads, so WebAuthn runs locally against
the iCloud-synced passkey — no Bluetooth, no Chrome caBLE, no relay
dance. The Worker only needs to pass a short signed blob from phone to
PC, and Durable Objects give us strong consistency for that hand-off
even when the two devices hit different Cloudflare POPs.

## Packages

| Package | What it does |
|---|---|
| [`@byterent/joyid-connect`](./packages/joyid-connect) | Frontend library: a drop-in `ccc.Signer` subclass + `<JoyIDConnectProvider>` React wrapper + `<JoyIDConnectModal>`. Pluggable into any CCC-based dApp. |
| [`@byterent/joyid-relay`](./packages/joyid-relay) | Cloudflare Worker that brokers the handshake. Exported as a library — you write a ~20-line consumer entry that configures CORS origins + optional branded logo, then `wrangler deploy`. Free-tier eligible (Durable Objects with `new_sqlite_classes`). |

Both are small on purpose — the combined source footprint is roughly
300 lines of TypeScript.

## Quick start

### 1. Deploy your own relay Worker

```bash
mkdir my-auth-worker && cd my-auth-worker
npm init -y
npm install @byterent/joyid-relay
npm install -D wrangler @cloudflare/workers-types typescript

cp node_modules/@byterent/joyid-relay/example/wrangler.example.toml ./wrangler.toml
cp -r node_modules/@byterent/joyid-relay/example/src ./src

# Edit wrangler.toml — set your Worker name + optional custom domain
# Edit src/index.ts — set your dApp's allowed origins + (optional) logo PNG

npx wrangler login
npx wrangler deploy
```

You'll get a URL like `https://my-auth.<account>.workers.dev`.

### 2. Wire the frontend

```bash
cd your-ckb-dapp
npm install @byterent/joyid-connect
# Peer deps if you don't already have them:
npm install @ckb-ccc/ccc @ckb-ccc/connector-react @joyid/common qr-code-styling
```

```tsx
// main.tsx
import { ccc } from '@ckb-ccc/connector-react';
import { JoyIDRedirectSignersController } from '@byterent/joyid-connect';
import { JoyIDConnectProvider } from '@byterent/joyid-connect/react';

const signersController = new JoyIDRedirectSignersController({
  network: 'testnet',
});

function App() {
  return (
    <ccc.Provider
      defaultClient={new ccc.ClientPublicTestnet()}
      name="MyDapp"
      icon="https://my-auth.workers.dev/logo.png"  // served by your relay Worker
      signersController={signersController}
    >
      <JoyIDConnectProvider
        appName="MyDapp"
        appIcon="https://my-auth.workers.dev/logo.png"
        network="testnet"
        workerUrl="https://my-auth.workers.dev"
      >
        {/* your routes */}
      </JoyIDConnectProvider>
    </ccc.Provider>
  );
}
```

That's it. User clicks Connect → picks JoyID → the QR modal appears →
scans with iPhone camera → Face ID → "Connected" on both screens.

## Why Cloudflare Workers specifically?

The phone-to-PC relay has one hard requirement: **strong consistency
between a write (phone callback) and a subsequent read (PC poll)** —
potentially from two different edge regions. Cloudflare Durable
Objects pin a given session id to exactly one runtime globally via
`idFromName()`, giving us immediate consistency for free and zero
infrastructure to run.

Workers KV is tempting but the wrong primitive — it's eventually
consistent (up to ~60s between POPs) and the first implementation of
this project hit that as a visible lag before swapping to DO.

Could you build the same thing on Lambda/Fly/Upstash? Sure, but you'd
be rebuilding this specific guarantee. DO gets it right for free.

## Status

- **v0.1 (this release):** Connect (auth) flow. Wallet address, pubkey,
  keyType delivered to the dApp. Persisted connection across reloads.
- **v0.2 (planned):** Transaction signing via the same redirect-relay
  pattern, hitting JoyID's `/sign-ckb-raw-tx` with a `redirect` mode.
- **v0.3 (planned):** Mainnet support (waits on JoyID mainnet
  availability — currently testnet-only).

Until v0.2 lands, `JoyIDRedirectSigner.signOnlyTransaction()` throws
an explicit "not implemented" error. Use a different wallet for
transactions in the interim (the CCC picker still shows UTXO-Global,
MetaMask, etc.).

## Why does the package scope say `@byterent/`?

This was extracted from the custom connector shipping in
[ByteRent](https://byterent.xyz), a CKB capacity-rental dApp. The
scope is a placeholder while the package finds a natural home — if
the CKB community is interested in adopting and maintaining this,
I'd happily re-scope under `@ckb-community`, `@nervos`, or similar.

## Known limitations

- **Testnet only** today (JoyID mainnet isn't supported yet — will
  follow when JoyID adds it).
- **Desktop focus.** The whole value prop is "desktop PC + iPhone" —
  if your dApp is mobile-first, users can connect directly via
  JoyID's native redirect in the same browser and this relay adds
  overhead.
- **Requires JoyID passkey already set up on the phone** (i.e., the
  user has used JoyID once in a phone browser session). First-time
  passkey enrolment still needs the standard JoyID onboarding flow.

## Contributing

Issues and PRs welcome. The one invariant to preserve: never call
WebAuthn on the PC. If a change would put `navigator.credentials.get()`
back in the PC-side code path, it defeats the whole point.

## License

MIT. Copyright 2026 ByteRent contributors.
