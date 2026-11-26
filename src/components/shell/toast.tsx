"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Toast = { id: number; text: string; icon: string };
type ToastFn = (text: string, icon?: string) => void;

const ToastContext = createContext<ToastFn>(() => undefined);

/** Demo-style toast: ink pill, bottom centre, 2.8s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const toast = useCallback<ToastFn>((text, icon = "✓") => {
    const id = ++next.current;
    setToasts((ts) => [...ts.slice(-2), { id, text, icon }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2800);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div aria-live="polite" role="status">
        {toasts.map((t, i) => (
          <div key={t.id} className="toast" style={{ bottom: 26 + i * 58 }}>
            <span aria-hidden>{t.icon}</span>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  return useContext(ToastContext);
}
