// @ts-expect-error - virtual module from vite-plugin-pwa
import { useRegisterSW } from 'virtual:pwa-register/react';

function PWABadge() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl: any, r: any) {
      console.log(`SW registered: ${swUrl}`);
      if (r) {
        setInterval(() => { r.update(); }, 60 * 60 * 1000);
      }
    },
    onRegisterError(error: any) {
      console.error('SW registration error:', error);
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-border px-4 py-3 rounded-xl shadow-lg flex items-center gap-3">
      <span className="text-sm">New version available</span>
      <button
        onClick={() => updateServiceWorker(true)}
        className="px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
      >
        Update
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        className="text-muted-foreground hover:text-foreground text-xs"
      >
        Later
      </button>
    </div>
  );
}

export default PWABadge;
