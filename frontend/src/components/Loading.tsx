import React from 'react'

interface LoadingProps {
  title?: string
  rows?: number
  cardHeightClass?: string
}

export default function Loading({ title, rows = 3, cardHeightClass = 'h-20' }: LoadingProps) {
  return (
    <div className="p-6">
      <div className="animate-pulse">
        {title ? <div className="h-8 bg-gray-200 rounded w-1/4 mb-6" /> : null}
        <div className="space-y-4">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className={`${cardHeightClass} bg-gray-200 rounded`} />
          ))}
        </div>
      </div>
    </div>
  )
}
