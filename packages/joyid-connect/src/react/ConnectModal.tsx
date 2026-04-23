// Modal shown while the user completes JoyID connect on their phone.
// Renders the QR + polling status + cancel button.
//
// Styling is intentionally vanilla inline-styles + a thin className hook.
// Consumers can override via `classNames` or re-implement the whole modal
// and call `beginJoyIDConnect()` directly if they want bespoke UX.

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { StyledQR } from './StyledQR';

export type ModalStatus = 'idle' | 'waiting' | 'error' | 'done';

export interface JoyIDConnectModalProps {
  qrPayloadUrl: string | null;
  status: ModalStatus;
  errorMessage?: string;
  onCancel: () => void;
  /** QR + logo customisation passed straight through to StyledQR. */
  logoSrc?: string;
  logoSize?: number;
  qrSize?: number;
  fgColor?: string;
  bgColor?: string;
  finderColor?: string;
  /** App-level title shown in the modal header (default: "Connect JoyID"). */
  title?: string;
  /** Additional CSS classes to layer on top of the built-in styles. */
  classNames?: {
    backdrop?: string;
    card?: string;
    title?: string;
    subtitle?: string;
    qrFrame?: string;
    steps?: string;
    status?: string;
    button?: string;
  };
  /** Replace the default backdrop with custom chrome if you'd rather. */
  style?: {
    backdrop?: CSSProperties;
    card?: CSSProperties;
  };
}

const defaultStyles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 200,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.7)',
    backdropFilter: 'blur(4px)',
    padding: '0 16px',
  },
  card: {
    width: '100%',
    maxWidth: 384,
    borderRadius: 12,
    background: '#141820',
    color: '#e6e8eb',
    padding: 24,
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
    font: '14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
  },
  qrFrame: {
    marginTop: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    background: '#ffffff',
    padding: 16,
  },
};

export function JoyIDConnectModal({
  qrPayloadUrl,
  status,
  errorMessage,
  onCancel,
  logoSrc,
  logoSize,
  qrSize,
  fgColor,
  bgColor,
  finderColor,
  title = 'Connect JoyID',
  classNames = {},
  style = {},
}: JoyIDConnectModalProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status !== 'waiting') {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      500,
    );
    return () => clearInterval(t);
  }, [status]);

  if (status === 'idle') return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className={classNames.backdrop}
      style={{ ...defaultStyles.backdrop, ...style.backdrop }}
      onClick={onCancel}
    >
      <div
        className={classNames.card}
        style={{ ...defaultStyles.card, ...style.card }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h2
              className={classNames.title}
              style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
            >
              {title}
            </h2>
            <p
              className={classNames.subtitle}
              style={{ margin: '4px 0 0', fontSize: 12, color: '#8a9199' }}
            >
              Scan with your iPhone camera — not inside the JoyID app.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              color: '#8a9199',
              cursor: 'pointer',
              fontSize: 16,
              padding: 4,
            }}
          >
            ✕
          </button>
        </header>

        <div className={classNames.qrFrame} style={defaultStyles.qrFrame}>
          {qrPayloadUrl ? (
            <StyledQR
              value={qrPayloadUrl}
              size={qrSize}
              logoSrc={logoSrc}
              logoSize={logoSize}
              fgColor={fgColor}
              bgColor={bgColor}
              finderColor={finderColor}
            />
          ) : (
            <div
              style={{
                width: qrSize ?? 248,
                height: qrSize ?? 248,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                color: '#8a9199',
              }}
            >
              Starting session…
            </div>
          )}
        </div>

        <ol
          className={classNames.steps}
          style={{
            marginTop: 20,
            paddingLeft: 0,
            listStyle: 'none',
            fontSize: 12,
            color: '#b5bcc4',
            lineHeight: 1.6,
          }}
        >
          <li>1. Open the camera app on your iPhone.</li>
          <li>2. Point it at this code — tap the banner that appears.</li>
          <li>3. Confirm on your iPhone with Face ID / Touch ID.</li>
        </ol>

        <div
          className={classNames.status}
          style={{ marginTop: 16, minHeight: 24, fontSize: 12 }}
        >
          {status === 'waiting' && (
            <span style={{ color: '#8a9199' }}>
              Waiting for your phone…{' '}
              <span style={{ fontFamily: 'monospace', color: '#6d747c' }}>
                {elapsed}s
              </span>
            </span>
          )}
          {status === 'done' && (
            <span style={{ color: '#1fd6a8' }}>Connected ✓</span>
          )}
          {status === 'error' && (
            <span style={{ color: '#ff6b6b' }}>
              {errorMessage ?? 'Something went wrong'}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onCancel}
          className={classNames.button}
          style={{
            marginTop: 20,
            width: '100%',
            padding: '8px 14px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            background: '#1f242d',
            color: '#e6e8eb',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {status === 'error' || status === 'done' ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
