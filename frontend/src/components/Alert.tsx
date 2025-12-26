import React, { useEffect } from 'react'
import { X, CheckCircle, AlertTriangle, Info, XCircle } from 'lucide-react'

export type AlertType = 'success' | 'error' | 'info' | 'warning'

interface AlertProps {
  type: AlertType
  message: string
  onClose?: () => void
  variant?: 'inline' | 'toast'
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  autoCloseMs?: number
}

const styles: Record<AlertType, { container: string; icon: JSX.Element }> = {
  success: {
    container: 'bg-green-50 border border-green-200 text-green-800',
    icon: <CheckCircle className="h-4 w-4" />
  },
  error: {
    container: 'bg-red-50 border border-red-200 text-red-800',
    icon: <XCircle className="h-4 w-4" />
  },
  info: {
    container: 'bg-blue-50 border border-blue-200 text-blue-800',
    icon: <Info className="h-4 w-4" />
  },
  warning: {
    container: 'bg-yellow-50 border border-yellow-200 text-yellow-800',
    icon: <AlertTriangle className="h-4 w-4" />
  }
}

const positionClasses: Record<NonNullable<AlertProps['position']>, string> = {
  'top-right': 'fixed top-4 right-4',
  'top-left': 'fixed top-4 left-4',
  'bottom-right': 'fixed bottom-4 right-4',
  'bottom-left': 'fixed bottom-4 left-4',
}

export default function Alert({
  type,
  message,
  onClose,
  variant = 'inline',
  position = 'top-right',
  autoCloseMs = 3500,
}: AlertProps) {
  // Auto-dismiss only if onClose provided
  useEffect(() => {
    if (!onClose) return
    const id = setTimeout(() => onClose(), autoCloseMs)
    return () => clearTimeout(id)
  }, [onClose, autoCloseMs])

  const content = (
    <div className={`flex items-start justify-between rounded-md px-3 py-2 text-sm shadow ${styles[type].container}`}>
      <div className="flex items-start space-x-2">
        <div className="mt-0.5">{styles[type].icon}</div>
        <div>{message}</div>
      </div>
      {onClose && (
        <button onClick={onClose} className="ml-3 text-current/70 hover:text-current">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )

  if (variant === 'toast') {
    return (
      <div className={`${positionClasses[position]} z-50 w-full max-w-sm mx-4`}>{content}</div>
    )
  }

  return content
}

// Optional viewport to stack multiple toasts together
export function ToastViewport({
  position = 'top-right',
  children,
}: {
  position?: NonNullable<AlertProps['position']>
  children: React.ReactNode
}) {
  return (
    <div className={`${positionClasses[position]} z-50 w-full max-w-sm mx-4 space-y-2`}>
      {children}
    </div>
  )
}
