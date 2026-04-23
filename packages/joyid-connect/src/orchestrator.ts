// Module-level bridge between a CCC signer (a plain class) and the UI
// layer that renders the QR. The signer's `connect()` needs to:
//   (a) fire a UI event so the modal opens
//   (b) wait for the user-driven flow to complete
//   (c) return the final connection payload
//
// React context isn't usable from a class instance built by the
// SignersController, so we expose a tiny global register + a single
// promise-returning request function. A React provider (or any other
// UI layer) calls registerJoyIDRequester() on mount, unsets on unmount.

import type { SessionHandle } from './signer';

type Requester = () => Promise<SessionHandle>;

let requester: Requester | undefined;

export function registerJoyIDRequester(fn: Requester): () => void {
  requester = fn;
  return () => {
    if (requester === fn) requester = undefined;
  };
}

export async function requestJoyIDConnect(): Promise<SessionHandle> {
  if (!requester) {
    throw new Error(
      '@byterent/joyid-connect: no JoyID requester registered. ' +
        'Mount <JoyIDConnectProvider> (or call registerJoyIDRequester directly) first.',
    );
  }
  return requester();
}
