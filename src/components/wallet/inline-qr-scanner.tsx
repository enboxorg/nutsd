/**
 * Inline square-viewfinder QR scanner.
 *
 * Lives INSIDE a modal as a 1:1 square (rather than the old full-screen
 * camera takeover). Drives its own state machine for:
 *
 *   - 'idle'        — dashed border, big camera icon, "Tap to scan" caption.
 *                     The whole square is a button that fires `onRequestStart`.
 *   - 'initializing' — spinner overlay while `getUserMedia` resolves.
 *   - 'scanning'    — live <video> with the corner-accent viewfinder overlay.
 *   - 'captured'    — brief success pulse after a code is detected.
 *   - 'error'       — camera-off icon + the error message + a retry button.
 *
 * The component is "uncontrolled" in the sense that it manages its own
 * MediaStream + animation frames, but the outer state (idle / initializing /
 * scanning / ...) is derived from whether `active` is true or false. The
 * parent controls when to start/stop by toggling `active`.
 *
 * Detection uses the native BarcodeDetector API. If unavailable (Safari,
 * Firefox), we render a friendly "paste instead" fallback.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraIcon, CameraOffIcon, Loader2Icon } from 'lucide-react';

interface InlineQrScannerProps {
  /**
   * When true, the scanner attempts to request camera access and start
   * scanning. When false, the stream is torn down and the idle square is
   * shown instead.
   */
  active: boolean;
  /** Called when the user taps the idle square to enable the camera. */
  onRequestStart: () => void;
  /** Called when a QR code is detected. The stream is stopped automatically. */
  onScan: (value: string) => void;
  /** Optional: called if the scanner fails to start (permission denied, no camera). */
  onError?: (message: string) => void;
}

type ScanState = 'idle' | 'initializing' | 'scanning' | 'captured' | 'error';

export const InlineQrScanner: React.FC<InlineQrScannerProps> = ({
  active,
  onRequestStart,
  onScan,
  onError,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | undefined>(undefined);
  const scannedRef = useRef(false);
  const [state, setState] = useState<ScanState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Stable ref to onScan to avoid re-starting the stream whenever the parent
  // passes a fresh function identity.
  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = undefined;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const handleDetected = useCallback((value: string) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setState('captured');
    stopCamera();
    // Brief capture flash before the parent processes the value.
    setTimeout(() => { onScanRef.current(value); }, 150);
  }, [stopCamera]);

  // Start / stop the camera based on `active`.
  useEffect(() => {
    if (!active) {
      stopCamera();
      scannedRef.current = false;
      setState('idle');
      setErrorMsg(null);
      return;
    }

    // Fire up the camera
    let cancelled = false;
    setState('initializing');
    setErrorMsg(null);
    scannedRef.current = false;

    (async () => {
      // Capability check first — no point asking for camera if we can't decode.
      if (!('BarcodeDetector' in window)) {
        if (!cancelled) {
          setErrorMsg('QR scanning is not supported in this browser. Try Chrome or Edge, or use Paste.');
          setState('error');
          onErrorRef.current?.('BarcodeDetector not available');
        }
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setState('scanning');

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
            // Expected: frame not ready for decoding yet — retry next frame.
          }
          animFrameRef.current = requestAnimationFrame(scan);
        };
        animFrameRef.current = requestAnimationFrame(scan);
      } catch (err) {
        if (cancelled) return;
        let msg = 'Failed to access camera.';
        if (err instanceof DOMException) {
          if (err.name === 'NotAllowedError') {
            msg = 'Camera access denied. Check your browser permissions.';
          } else if (err.name === 'NotFoundError') {
            msg = 'No camera found on this device.';
          }
        }
        setErrorMsg(msg);
        setState('error');
        onErrorRef.current?.(msg);
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [active, handleDetected, stopCamera]);

  // Idle state: the whole square is a big tappable button.
  if (state === 'idle') {
    return (
      <button
        type="button"
        onClick={onRequestStart}
        className="group relative aspect-square w-full rounded-2xl border-2 border-dashed border-border bg-muted/40 hover:bg-muted/70 hover:border-primary/60 transition-colors flex flex-col items-center justify-center gap-3"
      >
        <div className="p-4 rounded-full bg-background/80 group-hover:bg-background transition-colors">
          <CameraIcon className="h-8 w-8 text-muted-foreground group-hover:text-primary transition-colors" />
        </div>
        <div className="space-y-0.5 text-center">
          <div className="text-sm font-medium text-foreground">Tap to scan</div>
          <div className="text-[11px] text-muted-foreground">Point at any QR code</div>
        </div>
      </button>
    );
  }

  // All non-idle states render the same square container with different contents.
  return (
    <div className="relative aspect-square w-full rounded-2xl overflow-hidden bg-black border border-border">
      {/* Video is always mounted so the stream can attach. Hidden until scanning. */}
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full object-cover ${
          state === 'scanning' || state === 'captured' ? 'opacity-100' : 'opacity-0'
        } transition-opacity duration-200`}
        playsInline
        muted
      />

      {state === 'initializing' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/40">
          <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
          <div className="text-xs text-muted-foreground">Starting camera…</div>
        </div>
      )}

      {(state === 'scanning' || state === 'captured') && (
        <>
          {/* Viewfinder corner accents */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className={`relative w-3/5 aspect-square rounded-2xl transition-all duration-150 ${
                state === 'captured' ? 'scale-105' : 'scale-100'
              }`}
            >
              {/* Subtle darkening outside the viewfinder */}
              <div
                aria-hidden="true"
                className="absolute -inset-[100vmax] pointer-events-none"
                style={{ boxShadow: '0 0 0 100vmax rgba(0,0,0,0.35)' }}
              />
              {/* Corner accents */}
              <div
                className={`absolute -top-0.5 -left-0.5 w-7 h-7 border-t-2 border-l-2 rounded-tl-2xl transition-colors ${
                  state === 'captured' ? 'border-[var(--color-success)]' : 'border-primary'
                }`}
              />
              <div
                className={`absolute -top-0.5 -right-0.5 w-7 h-7 border-t-2 border-r-2 rounded-tr-2xl transition-colors ${
                  state === 'captured' ? 'border-[var(--color-success)]' : 'border-primary'
                }`}
              />
              <div
                className={`absolute -bottom-0.5 -left-0.5 w-7 h-7 border-b-2 border-l-2 rounded-bl-2xl transition-colors ${
                  state === 'captured' ? 'border-[var(--color-success)]' : 'border-primary'
                }`}
              />
              <div
                className={`absolute -bottom-0.5 -right-0.5 w-7 h-7 border-b-2 border-r-2 rounded-br-2xl transition-colors ${
                  state === 'captured' ? 'border-[var(--color-success)]' : 'border-primary'
                }`}
              />
            </div>
          </div>
          {state === 'scanning' && (
            <div className="absolute bottom-3 left-0 right-0 text-center text-[11px] text-white/80 drop-shadow">
              Point at a QR code
            </div>
          )}
        </>
      )}

      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-muted/40">
          <CameraOffIcon className="h-7 w-7 text-muted-foreground" />
          <div className="text-[11px] text-muted-foreground leading-relaxed">
            {errorMsg}
          </div>
        </div>
      )}
    </div>
  );
};
