// Subclass of ccc.SignersController that replaces the default JoyID popup
// signer with our redirect-relay based JoyIDRedirectSigner. Everything
// else (UTXO Global, MetaMask link, etc.) stays as CCC defaults.
//
// The signer itself delegates to `requestJoyIDConnect()` (from
// ./orchestrator), which in turn is provided by whatever UI layer the
// consumer chose — typically the React provider in ./react, but any
// caller can register a requester directly.

import { ccc } from '@ckb-ccc/ccc';
import type { WalletWithSigners, SignersControllerRefreshContext } from '@ckb-ccc/ccc';
import { JoyIDRedirectSigner } from './signer';
import { requestJoyIDConnect, requestJoyIDSign } from './orchestrator';
import { JOY_ID_ICON } from './joyidIcon';
import type { JoyIDNetwork } from './config';

export interface JoyIDRedirectSignersControllerOptions {
  network: JoyIDNetwork;
  /** Override JoyID's app URL — rarely needed; defaults to testnet/mainnet. */
  joyidAppUrl?: string;
  /** Override the wallet display name in the CCC picker (default: "JoyID"). */
  walletLabel?: string;
  /** Override the icon shown in the CCC picker. Defaults to the JoyID brand mark. */
  walletIcon?: string;
  /** localStorage key used to persist the connection. */
  storageKey?: string;
}

export class JoyIDRedirectSignersController extends ccc.SignersController {
  constructor(private readonly opts: JoyIDRedirectSignersControllerOptions) {
    super();
  }

  async addRealSigners(context: SignersControllerRefreshContext) {
    await super.addRealSigners(context);

    // Drop CCC's default JoyID Passkey wallet — its signers use
    // createPopup + WebAuthn, which hits Chrome's FIDO hybrid transport
    // (caBLE) on desktop and is notoriously flaky.
    context.wallets = context.wallets.filter(
      (w: WalletWithSigners) => w.name !== 'JoyID Passkey',
    );

    const signer = new JoyIDRedirectSigner(context.client, {
      appName: context.appName,
      appIcon: context.appIcon,
      network: this.opts.network,
      joyidAppUrl: this.opts.joyidAppUrl,
      storageKey: this.opts.storageKey,
      onConnectIntent: async () => {
        const handle = await requestJoyIDConnect();
        return handle.ready;
      },
      onSignIntent: async (payload) => requestJoyIDSign(payload),
    });

    await this.addSigners(
      this.opts.walletLabel ?? 'JoyID',
      this.opts.walletIcon ?? JOY_ID_ICON,
      [{ name: 'CKB', signer }],
      context,
    );
  }
}
