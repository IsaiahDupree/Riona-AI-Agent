import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import Alert, { AlertType } from './Alert'
import { ToastViewport } from './Alert'

export type ToastOptions = {
  type: AlertType
  message: string
  autoCloseMs?: number
}

interface Toast extends ToastOptions {
  id: string
}

interface ToastContextValue {
  show: (opts: ToastOptions) => void
  success: (message: string, opts?: Partial<ToastOptions>) => void
  error: (message: string, opts?: Partial<ToastOptions>) => void
  info: (message: string, opts?: Partial<ToastOptions>) => void
  warning: (message: string, opts?: Partial<ToastOptions>) => void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback((opts: ToastOptions) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    setToasts((prev) => [...prev, { id, ...opts }])
  }, [])

  const api = useMemo<ToastContextValue>(() => ({
    show,
    success: (message, opts) => show({ type: 'success', message, autoCloseMs: opts?.autoCloseMs }),
    error: (message, opts) => show({ type: 'error', message, autoCloseMs: opts?.autoCloseMs }),
    info: (message, opts) => show({ type: 'info', message, autoCloseMs: opts?.autoCloseMs }),
    warning: (message, opts) => show({ type: 'warning', message, autoCloseMs: opts?.autoCloseMs }),
  }), [show])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport position="top-right">
        {toasts.map((t) => (
          <Alert
            key={t.id}
            variant="toast"
            position="top-right"
            type={t.type}
            message={t.message}
            autoCloseMs={t.autoCloseMs}
            onClose={() => remove(t.id)}
          />
        ))}
      </ToastViewport>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return ctx
}
