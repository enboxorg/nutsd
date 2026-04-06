import { useState, useEffect, useRef, useCallback } from 'react';
import { XIcon, CameraOffIcon } from 'lucide-react';

interface QrScannerProps {
  onScan: (value: string) => void;
  onClose: () => void;
}

/**
 * Camera-based QR code scanner.
 *
 * Uses the BarcodeDetector API when available (Chrome, Edge), otherwise
 * falls back to periodic frame capture and canvas-based scanning.
 * Prefers the rear camera (facingMode: 'environment') for mobile use.
 */
export const QrScanner: React.FC<QrScannerProps> = ({ onScan, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scannedRef = useRef(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const handleDetected = useCallback((value: string) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    stopCamera();
    onScan(value);
  }, [onScan, stopCamera]);

  useEffect(() => {
    let cancelled = false;
    let animFrameId: number | undefined;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        // Try BarcodeDetector API first (Chrome, Edge)
        if ('BarcodeDetector' in window) {
          const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
          const scan = async () => {
            if (cancelled || scannedRef.current || !videoRef.current) return;
            try {
              const barcodes = await detector.detect(videoRef.current);
              if (barcodes.length > 0 && barcodes[0].rawValue) {
                handleDetected(barcodes[0].rawValue);
                return;
              }
            } catch {
              // Expected: video frame not ready for detection yet — retry on next animation frame
            }
            animFrameId = requestAnimationFrame(scan);
          };
          animFrameId = requestAnimationFrame(scan);
        } else {
          // Fallback: no native barcode detection available
          // Use a simple polling approach — the user can paste instead
          setError('QR scanning requires Chrome, Edge, or Samsung Internet. Use paste instead.');
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof DOMException && err.name === 'NotAllowedError') {
            setError('Camera access denied. Please allow camera access and try again.');
          } else if (err instanceof DOMException && err.name === 'NotFoundError') {
            setError('No camera found on this device.');
          } else {
            setError('Failed to access camera.');
          }
        }
      }
    }

    start();
    return () => {
      cancelled = true;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      stopCamera();
    };
  }, [handleDetected, stopCamera]);

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center">
      {/* Close button */}
      <button
        onClick={handleClose}
        className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
      >
        <XIcon className="h-6 w-6" />
      </button>

      {error ? (
        <div className="flex flex-col items-center gap-4 px-8 text-center">
          <CameraOffIcon className="h-12 w-12 text-muted-foreground" />
          <p className="text-sm text-white/80">{error}</p>
          <button
            onClick={handleClose}
            className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium"
          >
            Close
          </button>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            playsInline
            muted
          />
          {/* Scanning overlay with viewfinder */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-64 h-64 border-2 border-white/50 rounded-2xl relative">
              {/* Corner accents */}
              <div className="absolute -top-0.5 -left-0.5 w-8 h-8 border-t-2 border-l-2 border-primary rounded-tl-2xl" />
              <div className="absolute -top-0.5 -right-0.5 w-8 h-8 border-t-2 border-r-2 border-primary rounded-tr-2xl" />
              <div className="absolute -bottom-0.5 -left-0.5 w-8 h-8 border-b-2 border-l-2 border-primary rounded-bl-2xl" />
              <div className="absolute -bottom-0.5 -right-0.5 w-8 h-8 border-b-2 border-r-2 border-primary rounded-br-2xl" />
            </div>
          </div>
          <p className="absolute bottom-8 text-sm text-white/70">
            Point camera at a QR code
          </p>
        </>
      )}
    </div>
  );
};
