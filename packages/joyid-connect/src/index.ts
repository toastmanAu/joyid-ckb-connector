// Framework-agnostic entry point. The CCC Signer, session helpers, and
// relay client live here — any framework (React, Vue, Svelte, plain JS)
// can build a UI on top of beginJoyIDConnect() / beginJoyIDSign() +
// JoyIDRedirectSigner.
//
// The React-specific pieces (Provider, modal, QR) live at
// "@byterent/joyid-connect/react".

export {
  JoyIDRedirectSigner,
  beginJoyIDConnect,
  beginJoyIDSign,
  type JoyIDRedirectSignerOpts,
  type BeginConnectOptions,
  type BeginSignOptions,
  type PersistedConnection,
  type SessionHandle,
  type SignSessionHandle,
  type SignIntentPayload,
  type TxPreview,
} from './signer';

export {
  createRelayClient,
  type RelayClient,
  type CreateSessionResponse,
  type CreateTxSessionResponse,
  type PollResponse,
  type TxPreviewPayload,
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
  registerJoyIDSignRequester,
  requestJoyIDSign,
} from './orchestrator';
