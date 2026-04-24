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
import {
  JoyIDRedirectSigner,
  beginSameDeviceConnect,
  beginSameDeviceSign,
} from './signer';
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
  /**
   * When true, the connect flow uses JoyID's same-device
   * `authWithRedirect` (top-level nav away + redirect back) instead
   * of the cross-device relay (QR + phone scan). Set this on mobile,
   * where the passkey lives on the same device.
   *
   * Note: sign-flow on same-device mode is NOT yet implemented —
   * calling `signOnlyTransaction` will fail until that ships.
   */
  sameDevice?: boolean;
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

    // Pre-compute the CCC wallet/signer-name pair so same-device's
    // pre-navigation localStorage prime uses the exact values we
    // register with addSigners below.
    const cccWalletName = this.opts.walletLabel ?? 'JoyID';
    const cccSignerName = 'CKB';

    const signer = new JoyIDRedirectSigner(context.client, {
      appName: context.appName,
      appIcon: context.appIcon,
      network: this.opts.network,
      joyidAppUrl: this.opts.joyidAppUrl,
      storageKey: this.opts.storageKey,
      onConnectIntent: this.opts.sameDevice
        ? async () => {
            await beginSameDeviceConnect({
              appName: context.appName,
              appIcon: context.appIcon,
              network: this.opts.network,
              joyidAppUrl: this.opts.joyidAppUrl,
              storageKey: this.opts.storageKey,
              cccWalletName,
              cccSignerName,
            });
            throw new Error('unreachable — page navigated to JoyID');
          }
        : async () => {
            const handle = await requestJoyIDConnect();
            return handle.ready;
          },
      onSignIntent: this.opts.sameDevice
        ? async (payload) => {
            // Same-device sign navigates away; the caller's Promise
            // never resolves. On the return page load, consumers
            // call `consumeSameDeviceSignResult()` to reconstruct
            // and submit the signed tx.
            await beginSameDeviceSign({
              tx: payload.tx,
              witnessIndexes: payload.witnessIndexes,
              signerAddress: payload.signerAddress,
              preview: payload.preview,
              appName: context.appName,
              appIcon: context.appIcon,
              network: this.opts.network,
              joyidAppUrl: this.opts.joyidAppUrl,
            });
            throw new Error('unreachable — page navigated to JoyID');
          }
        : async (payload) => requestJoyIDSign(payload),
    });

    await this.addSigners(
      cccWalletName,
      this.opts.walletIcon ?? JOY_ID_ICON,
      [{ name: cccSignerName, signer }],
      context,
    );
  }
}
