// Framework-agnostic entry point. The CCC Signer, session helper, and
// relay client live here — any framework (React, Vue, Svelte, plain JS)
// can build a UI on top of beginJoyIDConnect() + JoyIDRedirectSigner.
//
// The React-specific pieces (Provider, modal, QR) live at
// "@byterent/joyid-connect/react".

export {
  JoyIDRedirectSigner,
  beginJoyIDConnect,
  type JoyIDRedirectSignerOpts,
  type BeginConnectOptions,
  type PersistedConnection,
  type SessionHandle,
} from './signer';

export {
  createRelayClient,
  type RelayClient,
  type CreateSessionResponse,
  type PollResponse,
} from './worker';

export { resolveJoyIDAppUrl, type JoyIDNetwork } from './config';

export { JOY_ID_ICON } from './joyidIcon';

export {
  JoyIDRedirectSignersController,
  type JoyIDRedirectSignersControllerOptions,
} from './signersController';

export {
  registerJoyIDRequester,
  requestJoyIDConnect,
} from './orchestrator';
