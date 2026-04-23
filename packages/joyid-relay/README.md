# @byterent/joyid-relay

Cloudflare Worker + Durable Object that brokers the JoyID phone→PC auth
handshake. Paired with
[`@byterent/joyid-connect`](../joyid-connect) on the frontend.

## What it does

- `POST /session` — creates a session id backed by a fresh Durable Object
  instance with a 120s TTL alarm. Returns `{ id, ttl }`.
- `GET /session/:id/callback` — the phone's JoyID redirect target. JoyID
  appends `?_data_=<base64>&joyid-redirect=true` on success. The Worker
  stores the payload in the DO and shows a branded "Signed in" page.
- `GET /session/:id` — the PC long-polls here. Returns
  `{ data: string | null, expired: boolean }`; consumes the payload
  on first read (replay polls 410).
- `GET /logo.png` — optional. Serves your inlined brand PNG so JoyID's
  auth screen and the phone's "Signed in" page share a single asset.

One DO instance per session id (via `idFromName(sessionId)`) means
strong consistency between the phone callback and PC poll — no KV
eventual-consistency lag between POPs.

## Install + deploy

```bash
cd my-auth-worker
npm install @byterent/joyid-relay

cp node_modules/@byterent/joyid-relay/example/wrangler.example.toml ./wrangler.toml
cp node_modules/@byterent/joyid-relay/example/src/index.ts ./src/index.ts

# Edit wrangler.toml — set your Worker name + optional custom domain
# Edit src/index.ts — set your dApp's allowed origins + (optional) logo

npx wrangler login
npx wrangler deploy
```

Output will be a URL like `https://my-auth.<account>.workers.dev`.
Point your frontend's `JoyIDConnectProvider` at it:

```tsx
<JoyIDConnectProvider
  workerUrl="https://my-auth.<account>.workers.dev"
  ...
/>
```

## Branding

Pass your PNG base64-inlined via the `logo` option. The same asset is
served at `/logo.png` (for JoyID's app to fetch as the dApp icon) and
embedded as a data URL in the "Signed in" HTML page (so the phone
renders your brand instantly on a flaky cell connection).

```ts
import logoB64 from './logo.generated.js'; // auto-generated from PNG

export default makeRelayWorker({
  allowedOrigins: [...],
  logo: { contentType: 'image/png', base64: logoB64 },
});
```

## Operational notes

- Durable Objects with `new_sqlite_classes` are Free-plan eligible.
- No KV namespace setup required.
- Sessions self-expire via DO alarm — no background cron.
- CORS allowlist is enforced strictly on `/session` + polling routes;
  `/callback` is a top-level navigation so CORS doesn't apply; `/logo.png`
  is wildcarded so JoyID's origin can fetch it.

## License

MIT
