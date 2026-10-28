import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined') {
  if ('caches' in window) {
    caches
      .keys()
      .then((keys) => {
        for (const key of keys) {
          if (key.includes('workbox-precache') || key.includes('v1') || key.includes('v2')) {
            caches.delete(key).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    if (import.meta.env.DEV) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => {
          for (const r of regs) {
            r.update().catch(() => {});
            r.unregister().catch(() => {});
          }
        })
        .catch(() => {});
    } else {
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });

      const checkSwUpdate = () => {
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => {
            for (const r of regs) {
              r.update().catch(() => {});
            }
          })
          .catch(() => {});
      };

      window.addEventListener('focus', checkSwUpdate);
      setTimeout(checkSwUpdate, 1000);
    }
  }
}

createRoot(document.getElementById('root')!).render(<App />);

