import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

interface QRCodeDisplayProps {
  value: string;
  size?: number;
  className?: string;
}

/**
 * Renders a QR code to a canvas element.
 * Uses the `qrcode` library for generation.
 */
export const QRCodeDisplay: React.FC<QRCodeDisplayProps> = ({
  value,
  size = 200,
  className,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !value) return;

    QRCode.toCanvas(canvasRef.current, value.toUpperCase(), {
      width: size,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'L',
    }).catch((err) => {
      console.error('QR code generation failed:', err);
    });
  }, [value, size]);

  return (
    <div className={`flex items-center justify-center ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        className="rounded-lg"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
};
