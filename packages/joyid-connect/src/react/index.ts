// React entry point — Provider + modal + QR. Consumers who prefer a
// different framework can build against the framework-agnostic exports
// from "@byterent/joyid-connect".

export {
  JoyIDConnectProvider,
  type JoyIDConnectProviderProps,
} from './JoyIDConnectProvider';

export {
  JoyIDConnectModal,
  type JoyIDConnectModalProps,
  type ModalStatus,
} from './ConnectModal';

export { StyledQR, type StyledQRProps } from './StyledQR';
