// Lightweight React wrapper around qr-code-styling. We mount the library
// into a ref'd <div>, not into React's VDOM — the lib renders its own
// SVG into that container. This gives us rounded modules + coloured
// finder patterns that qrcode.react can't do, while staying framework-
// neutral under the hood.

import { useEffect, useRef } from 'react';
import QRCodeStyling from 'qr-code-styling';

export interface StyledQRProps {
  value: string;
  size?: number;
  logoSrc?: string;
  logoSize?: number;
  fgColor?: string;
  bgColor?: string;
  /**
   * Color for the 3 corner finder patterns. Different from fgColor gives
   * a subtle brand flourish at zero scan-reliability cost — scanners lock
   * on shape, not color.
   */
  finderColor?: string;
}

export function StyledQR({
  value,
  size = 248,
  logoSrc,
  logoSize = 56,
  fgColor = '#0b0d10',
  bgColor = '#ffffff',
  finderColor,
}: StyledQRProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const qrRef = useRef<QRCodeStyling | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const cornerColor = finderColor ?? fgColor;

    if (!qrRef.current) {
      qrRef.current = new QRCodeStyling({
        width: size,
        height: size,
        type: 'svg',
        data: value,
        dotsOptions: { type: 'rounded', color: fgColor },
        cornersSquareOptions: { type: 'extra-rounded', color: cornerColor },
        cornersDotOptions: { type: 'dot', color: cornerColor },
        backgroundOptions: { color: bgColor },
        qrOptions: {
          errorCorrectionLevel: 'H', // required by the logo excavation
        },
        image: logoSrc,
        imageOptions: {
          crossOrigin: 'anonymous',
          margin: 2,
          imageSize: logoSize / size,
          hideBackgroundDots: true,
        },
      });
      while (ref.current.firstChild) ref.current.removeChild(ref.current.firstChild);
      qrRef.current.append(ref.current);
      return;
    }

    qrRef.current.update({
      data: value,
      width: size,
      height: size,
      image: logoSrc,
      imageOptions: {
        crossOrigin: 'anonymous',
        margin: 2,
        imageSize: logoSize / size,
        hideBackgroundDots: true,
      },
      dotsOptions: { type: 'rounded', color: fgColor },
      cornersSquareOptions: { type: 'extra-rounded', color: cornerColor },
      cornersDotOptions: { type: 'dot', color: cornerColor },
      backgroundOptions: { color: bgColor },
    });
  }, [value, size, logoSrc, logoSize, fgColor, bgColor, finderColor]);

  return <div ref={ref} style={{ width: size, height: size }} />;
}
