// Wires the QR modal + a CCC (or other) outer modal together. Sits above
// wherever you mount <ccc.Provider> so that (a) the CCC wallet picker
// can be closed when our flow begins, and (b) our QR modal renders on
// top of it.
//
// The provider handles two flows — connect (ready: PersistedConnection)
// and sign (ready: ccc.Transaction) — with the same modal chrome. Only
// the title + status copy changes.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ccc } from '@ckb-ccc/core';
import { beginJoyIDConnect, beginJoyIDSign } from '../signer';
import type {
  SessionHandle,
  SignSessionHandle,
  SignIntentPayload,
} from '../signer';
import { createRelayClient } from '../worker';
import {
  registerJoyIDRequester,
  registerJoyIDSignRequester,
} from '../orchestrator';
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

  /**
   * Called when this provider begins a sign flow. Typical use: close any
   * outer UI so the QR modal is the focused interaction.
   */
  onBeginSign?: () => void;

  /** Forwarded to the QR modal — styling + branding hooks. */
  modalProps?: Partial<Omit<JoyIDConnectModalProps, 'qrPayloadUrl' | 'status' | 'errorMessage' | 'onCancel' | 'title'>>;

  /** Title override for the connect modal. Default: "Connect JoyID". */
  connectTitle?: string;

  /** Title override for the sign modal. Default: "Sign transaction". */
  signTitle?: string;
}

type FlowKind = 'connect' | 'sign';
type ModalState =
  | { status: 'idle' }
  | { status: 'waiting'; qrPayloadUrl: string; flow: FlowKind }
  | { status: 'done'; flow: FlowKind }
  | { status: 'error'; message: string; flow: FlowKind };

export function JoyIDConnectProvider({
  children,
  appName,
  appIcon,
  network,
  workerUrl,
  onBeginConnect,
  onBeginSign,
  modalProps,
  connectTitle = 'Connect JoyID',
  signTitle = 'Sign transaction',
}: JoyIDConnectProviderProps) {
  const [modal, setModal] = useState<ModalState>({ status: 'idle' });
  const activeConnectRef = useRef<SessionHandle | null>(null);
  const activeSignRef = useRef<SignSessionHandle | null>(null);

  const requestConnect = useCallback(async (): Promise<SessionHandle> => {
    activeConnectRef.current?.cancel();
    activeSignRef.current?.cancel();

    onBeginConnect?.();
    setModal({ status: 'waiting', qrPayloadUrl: '', flow: 'connect' });

    const relay = createRelayClient(workerUrl);
    const handle = await beginJoyIDConnect({
      appName,
      appIcon,
      network,
      relay,
    });
    activeConnectRef.current = handle;
    setModal({ status: 'waiting', qrPayloadUrl: handle.qrPayloadUrl, flow: 'connect' });

    handle.ready.then(
      () => {
        setModal({ status: 'done', flow: 'connect' });
        setTimeout(() => setModal({ status: 'idle' }), 600);
      },
      (err: unknown) => {
        setModal({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          flow: 'connect',
        });
      },
    );

    return handle;
  }, [appName, appIcon, network, workerUrl, onBeginConnect]);

  const requestSign = useCallback(
    async (payload: SignIntentPayload): Promise<ccc.Transaction> => {
      activeConnectRef.current?.cancel();
      activeSignRef.current?.cancel();

      onBeginSign?.();
      setModal({ status: 'waiting', qrPayloadUrl: '', flow: 'sign' });

      const relay = createRelayClient(workerUrl);

      let handle: SignSessionHandle;
      try {
        handle = await beginJoyIDSign({
          tx: payload.tx,
          witnessIndexes: payload.witnessIndexes,
          signerAddress: payload.signerAddress,
          appName,
          appIcon,
          network,
          relay,
        });
      } catch (err) {
        // Setup errors (missing witnesses, challenge compute fail, relay
        // unreachable) used to silently hang the modal on "Starting
        // session…" — surface them as a visible error instead.
        setModal({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          flow: 'sign',
        });
        throw err;
      }
      activeSignRef.current = handle;
      setModal({ status: 'waiting', qrPayloadUrl: handle.launchUrl, flow: 'sign' });

      try {
        const signed = await handle.ready;
        setModal({ status: 'done', flow: 'sign' });
        setTimeout(() => setModal({ status: 'idle' }), 600);
        return signed;
      } catch (err) {
        setModal({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          flow: 'sign',
        });
        throw err;
      }
    },
    [appName, appIcon, network, workerUrl, onBeginSign],
  );

  useEffect(() => registerJoyIDRequester(requestConnect), [requestConnect]);
  useEffect(() => registerJoyIDSignRequester(requestSign), [requestSign]);

  const cancel = () => {
    activeConnectRef.current?.cancel();
    activeConnectRef.current = null;
    activeSignRef.current?.cancel();
    activeSignRef.current = null;
    setModal({ status: 'idle' });
  };

  const currentTitle =
    modal.status !== 'idle' && modal.flow === 'sign' ? signTitle : connectTitle;

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
        title={currentTitle}
        onCancel={cancel}
      />
    </>
  );
}
