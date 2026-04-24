// Module-level bridge between a CCC signer (a plain class) and the UI
// layer that renders the QR. The signer's `connect()` / `sign()` need
// to (a) fire a UI event so the modal opens, (b) wait for the user-
// driven flow to complete, (c) return the final payload.
//
// React context isn't usable from a class instance built by the
// SignersController, so we expose a tiny global register + a single
// promise-returning request function per flow. A React provider (or
// any other UI layer) calls the register function on mount, unsets on
// unmount.

import type { SessionHandle, SignIntentPayload } from './signer';
import type { ccc } from '@ckb-ccc/core';

type ConnectRequester = () => Promise<SessionHandle>;
type SignRequester = (payload: SignIntentPayload) => Promise<ccc.Transaction>;

let connectRequester: ConnectRequester | undefined;
let signRequester: SignRequester | undefined;

export function registerJoyIDRequester(fn: ConnectRequester): () => void {
  connectRequester = fn;
  return () => {
    if (connectRequester === fn) connectRequester = undefined;
  };
}

export async function requestJoyIDConnect(): Promise<SessionHandle> {
  if (!connectRequester) {
    throw new Error(
      '@byterent/joyid-connect: no JoyID connect requester registered. ' +
        'Mount <JoyIDConnectProvider> (or call registerJoyIDRequester directly) first.',
    );
  }
  return connectRequester();
}

export function registerJoyIDSignRequester(fn: SignRequester): () => void {
  signRequester = fn;
  return () => {
    if (signRequester === fn) signRequester = undefined;
  };
}

export async function requestJoyIDSign(
  payload: SignIntentPayload,
): Promise<ccc.Transaction> {
  if (!signRequester) {
    throw new Error(
      '@byterent/joyid-connect: no JoyID sign requester registered. ' +
        'Mount <JoyIDConnectProvider> with sign support to enable signOnlyTransaction.',
    );
  }
  return signRequester(payload);
}
