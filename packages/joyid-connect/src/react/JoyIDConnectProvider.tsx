// Wires the QR modal + a CCC (or other) outer modal together. Sits above
// wherever you mount <ccc.Provider> so that (a) the CCC wallet picker
// can be closed when our flow begins, and (b) our QR modal renders on
// top of it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { beginJoyIDConnect } from '../signer';
import type { SessionHandle } from '../signer';
import { createRelayClient } from '../worker';
import { registerJoyIDRequester } from '../orchestrator';
import { JoyIDConnectModal } from './ConnectModal';
import type { JoyIDConnectModalProps } from './ConnectModal';
import type { JoyIDNetwork } from '../config';

export interface JoyIDConnectProviderProps {
  children: ReactNode;

  /** Display name of your dApp. Shown in the JoyID auth screen. */
  appName: string;
  /** Public HTTPS URL of your dApp's logo. Shown in the JoyID auth screen. */
  appIcon: string;
  /** 'mainnet' or 'testnet' — picks the JoyID app URL. */
  network: JoyIDNetwork;

  /** Your deployed joyid-relay Worker URL (e.g. https://auth.mydapp.xyz). */
  workerUrl: string;

  /**
   * Called when this provider begins a connect flow. Typical use: close
   * the outer CCC wallet-picker so the QR modal becomes the focused UI.
   */
  onBeginConnect?: () => void;

  /** Forwarded to the QR modal — styling + branding hooks. */
  modalProps?: Partial<Omit<JoyIDConnectModalProps, 'qrPayloadUrl' | 'status' | 'errorMessage' | 'onCancel'>>;
}

type ModalState =
  | { status: 'idle' }
  | { status: 'waiting'; qrPayloadUrl: string }
  | { status: 'done' }
  | { status: 'error'; message: string };

export function JoyIDConnectProvider({
  children,
  appName,
  appIcon,
  network,
  workerUrl,
  onBeginConnect,
  modalProps,
}: JoyIDConnectProviderProps) {
  const [modal, setModal] = useState<ModalState>({ status: 'idle' });
  const activeHandleRef = useRef<SessionHandle | null>(null);

  const request = useCallback(async (): Promise<SessionHandle> => {
    activeHandleRef.current?.cancel();

    onBeginConnect?.();
    setModal({ status: 'waiting', qrPayloadUrl: '' });

    const relay = createRelayClient(workerUrl);
    const handle = await beginJoyIDConnect({
      appName,
      appIcon,
      network,
      relay,
    });
    activeHandleRef.current = handle;
    setModal({ status: 'waiting', qrPayloadUrl: handle.qrPayloadUrl });

    handle.ready.then(
      () => {
        setModal({ status: 'done' });
        setTimeout(() => setModal({ status: 'idle' }), 600);
      },
      (err: unknown) => {
        setModal({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );

    return handle;
  }, [appName, appIcon, network, workerUrl, onBeginConnect]);

  useEffect(() => registerJoyIDRequester(request), [request]);

  const cancel = () => {
    activeHandleRef.current?.cancel();
    activeHandleRef.current = null;
    setModal({ status: 'idle' });
  };

  return (
    <>
      {children}
      <JoyIDConnectModal
        {...modalProps}
        qrPayloadUrl={modal.status === 'waiting' ? modal.qrPayloadUrl || null : null}
        status={
          modal.status === 'waiting'
            ? 'waiting'
            : modal.status === 'done'
              ? 'done'
              : modal.status === 'error'
                ? 'error'
                : 'idle'
        }
        errorMessage={modal.status === 'error' ? modal.message : undefined}
        onCancel={cancel}
      />
    </>
  );
}
