# @byterent/joyid-connect

Mobile-first JoyID connector for CCC-based CKB dApps. Provides a custom
`Signer` + React `<JoyIDConnectProvider>` + `<JoyIDConnectModal>` that
swap out CCC's default JoyID flow (which relies on Chrome's flaky
WebAuthn hybrid transport) for a QR-scan-on-phone → relay-Worker →
PC flow.

Paired with [`@byterent/joyid-relay`](../joyid-relay) (the Cloudflare
Worker that brokers the handshake).

## Install

```bash
npm install @byterent/joyid-connect
# peer deps
npm install @ckb-ccc/core @joyid/common qr-code-styling react
```

## Usage (React + CCC)

```tsx
import { ccc } from '@ckb-ccc/connector-react';
import { JoyIDRedirectSignersController } from '@byterent/joyid-connect';
import { JoyIDConnectProvider } from '@byterent/joyid-connect/react';

const signersController = new JoyIDRedirectSignersController({
  network: 'testnet',
  // Optional: storageKey, walletLabel, walletIcon
});

function App() {
  return (
    <ccc.Provider
      defaultClient={new ccc.ClientPublicTestnet()}
      name="MyDapp"
      icon="https://mydapp.xyz/logo.png"
      signersController={signersController}
    >
      <JoyIDConnectProvider
        appName="MyDapp"
        appIcon="https://auth.mydapp.xyz/logo.png"
        network="testnet"
        workerUrl="https://auth.mydapp.xyz"
        modalProps={{
          logoSrc: '/brand/qr-logo.png',
          logoSize: 56,
          finderColor: '#0CC095',
        }}
      >
        <MyDappRoutes />
      </JoyIDConnectProvider>
    </ccc.Provider>
  );
}
```

`appIcon` **must be a publicly reachable HTTPS URL** — JoyID's app fetches
it server-side to render your brand during auth. Pointing it at your
relay Worker's `/logo.png` endpoint is the cleanest pattern.

## What's in the package

| Entry | Exports |
|---|---|
| `@byterent/joyid-connect` | `JoyIDRedirectSigner`, `JoyIDRedirectSignersController`, `beginJoyIDConnect`, `createRelayClient`, `JOY_ID_ICON`, types |
| `@byterent/joyid-connect/react` | `<JoyIDConnectProvider>`, `<JoyIDConnectModal>`, `<StyledQR>` |

## What's NOT implemented (v0.1)

- **Transaction signing.** `signOnlyTransaction()` throws "not yet
  implemented". v0.2 will add the same redirect-relay pattern against
  JoyID's `/sign-ckb-raw-tx` endpoint.
- **Non-React UIs.** React is the only wrapper shipped. The
  framework-agnostic entry point (`@byterent/joyid-connect`) exposes
  everything you need to build a Vue / Svelte / plain-JS wrapper.

## License

MIT
