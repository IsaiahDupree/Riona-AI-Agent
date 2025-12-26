import React, { useState, useEffect } from 'react'
import { X, Save, RotateCcw, Clock, User, MessageSquare, Hash, Smile, AlertTriangle } from 'lucide-react'
import { format } from 'date-fns'

interface ResponseStyle {
  id: string
  name: string
  persona: string
  rules: string[]
  maxLen: number
  emojis: boolean
  hashtags: boolean
}

interface ApprovalItem {
  id: string
  interactionId: string
  type: 'comment' | 'like' | 'post'
  targetUser: string
  targetPost?: string
  originalContent: string
  modifiedContent: string
  responseStyle?: string
  toxicityScore: number
  qualityScore: number
  similarityScore: number
  state: 'pending_review' | 'approved' | 'denied' | 'scheduled' | 'executed' | 'failed' | 'expired'
  scheduledTime?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

interface ReviewDrawerProps {
  isOpen: boolean
  onClose: () => void
  approvalItem: ApprovalItem | null
  onSave: (item: ApprovalItem) => void
  onApprove: (itemId: string) => void
  onDeny: (itemId: string, reason: string) => void
  onSchedule: (itemId: string, scheduledTime: Date) => void
}

export default function ReviewDrawer({
  isOpen,
  onClose,
  approvalItem,
  onSave,
  onApprove,
  onDeny,
  onSchedule
}: ReviewDrawerProps) {
  const [editedContent, setEditedContent] = useState('')
  const [selectedStyleId, setSelectedStyleId] = useState('')
  const [notes, setNotes] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [responseStyles, setResponseStyles] = useState<ResponseStyle[]>([])
  const [loading, setLoading] = useState(false)
  const [contentStats, setContentStats] = useState({
    length: 0,
    words: 0,
    emojis: 0,
    hashtags: 0,
    mentions: 0
  })

  useEffect(() => {
    if (approvalItem) {
      setEditedContent(approvalItem.modifiedContent || approvalItem.originalContent)
      setSelectedStyleId(approvalItem.responseStyle || '')
      setNotes(approvalItem.notes || '')
      setScheduledTime(approvalItem.scheduledTime ? 
        new Date(approvalItem.scheduledTime).toISOString().slice(0, 16) : ''
      )
    }
  }, [approvalItem])

  useEffect(() => {
    fetchResponseStyles()
  }, [])

  useEffect(() => {
    updateContentStats(editedContent)
  }, [editedContent])

  const fetchResponseStyles = async () => {
    try {
      const response = await fetch('/api/hitl/styles')
      const styles = await response.json()
      setResponseStyles(styles)
    } catch (error) {
      console.error('Failed to fetch response styles:', error)
      // Mock data for development
      setResponseStyles([
        {
          id: 'casual_friendly',
          name: 'Casual & Friendly',
          persona: 'A friendly, casual commenter',
          rules: ['Keep comments short', 'Use positive language'],
          maxLen: 50,
          emojis: true,
          hashtags: false
        }
      ])
    }
  }

  const updateContentStats = (content: string) => {
    const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu
    const hashtagRegex = /#\w+/g
    const mentionRegex = /@\w+/g
    
    setContentStats({
      length: content.length,
      words: content.trim() ? content.trim().split(/\s+/).length : 0,
      emojis: (content.match(emojiRegex) || []).length,
      hashtags: (content.match(hashtagRegex) || []).length,
      mentions: (content.match(mentionRegex) || []).length
    })
  }

  const handleSave = () => {
    if (!approvalItem) return

    const updatedItem = {
      ...approvalItem,
      modifiedContent: editedContent,
      responseStyle: selectedStyleId,
      notes,
      scheduledTime: scheduledTime ? new Date(scheduledTime).toISOString() : undefined
    }

    onSave(updatedItem)
  }

  const handleApprove = () => {
    if (!approvalItem) return
    handleSave()
    onApprove(approvalItem.id)
  }

  const handleDeny = () => {
    if (!approvalItem) return
    const reason = notes || 'Content does not meet guidelines'
    onDeny(approvalItem.id, reason)
  }

  const handleSchedule = () => {
    if (!approvalItem || !scheduledTime) return
    handleSave()
    onSchedule(approvalItem.id, new Date(scheduledTime))
  }

  const resetToOriginal = () => {
    if (approvalItem) {
      setEditedContent(approvalItem.originalContent)
    }
  }

  const applyResponseStyle = (styleId: string) => {
    const style = responseStyles.find(s => s.id === styleId)
    if (!style) return

    setSelectedStyleId(styleId)
    
    // Apply style constraints
    let content = editedContent
    
    if (content.length > style.maxLen) {
      content = content.substring(0, style.maxLen).trim()
      if (content.endsWith('.')) content = content.slice(0, -1)
      content += '...'
    }
    
    if (!style.emojis) {
      content = content.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
    }
    
    if (!style.hashtags) {
      content = content.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim()
    }
    
    setEditedContent(content)
  }

  const selectedStyle = responseStyles.find(s => s.id === selectedStyleId)

  if (!isOpen || !approvalItem) {
    return null
  }

  const exceedsMaxLength = selectedStyle && editedContent.length > selectedStyle.maxLen
  const hasUnsupportedEmojis = selectedStyle && !selectedStyle.emojis && contentStats.emojis > 0
  const hasUnsupportedHashtags = selectedStyle && !selectedStyle.hashtags && contentStats.hashtags > 0

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={onClose} />
      
      <div className="absolute right-0 top-0 h-full w-full max-w-2xl bg-white shadow-xl">
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <div className="flex items-center space-x-3">
              <MessageSquare className="h-6 w-6 text-blue-600" />
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Review Interaction</h2>
                <p className="text-sm text-gray-500">
                  {approvalItem.type} for @{approvalItem.targetUser}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            <div className="space-y-6">
              {/* Target Information */}
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="mb-3 font-medium text-gray-900">Target Information</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">User:</span>
                    <span className="ml-2 font-medium">@{approvalItem.targetUser}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Type:</span>
                    <span className="ml-2 font-medium capitalize">{approvalItem.type}</span>
                  </div>
                  {approvalItem.targetPost && (
                    <div className="col-span-2">
                      <span className="text-gray-500">Post:</span>
                      <span className="ml-2 font-medium">{approvalItem.targetPost}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Original vs Modified Content */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-gray-200 p-4">
                  <h3 className="mb-2 font-medium text-gray-900">Original Content</h3>
                  <div className="rounded border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
                    {approvalItem.originalContent}
                  </div>
                </div>
                
                <div className="rounded-lg border border-gray-200 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="font-medium text-gray-900">Modified Content</h3>
                    <button
                      onClick={resetToOriginal}
                      className="flex items-center space-x-1 text-sm text-blue-600 hover:text-blue-800"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Reset</span>
                    </button>
                  </div>
                  <textarea
                    value={editedContent}
                    onChange={(e) => setEditedContent(e.target.value)}
                    className="w-full rounded border border-gray-300 p-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    rows={4}
                    placeholder="Enter modified content..."
                  />
                </div>
              </div>

              {/* Content Statistics */}
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="mb-3 font-medium text-gray-900">Content Statistics</h3>
                <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-500">Length:</span>
                    <span className={`font-medium ${exceedsMaxLength ? 'text-red-600' : 'text-gray-900'}`}>
                      {contentStats.length}
                      {selectedStyle && ` / ${selectedStyle.maxLen}`}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-500">Words:</span>
                    <span className="font-medium text-gray-900">{contentStats.words}</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Smile className="h-4 w-4 text-gray-400" />
                    <span className={`font-medium ${hasUnsupportedEmojis ? 'text-red-600' : 'text-gray-900'}`}>
                      {contentStats.emojis}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Hash className="h-4 w-4 text-gray-400" />
                    <span className={`font-medium ${hasUnsupportedHashtags ? 'text-red-600' : 'text-gray-900'}`}>
                      {contentStats.hashtags}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <User className="h-4 w-4 text-gray-400" />
                    <span className="font-medium text-gray-900">{contentStats.mentions}</span>
                  </div>
                </div>
                
                {(exceedsMaxLength || hasUnsupportedEmojis || hasUnsupportedHashtags) && (
                  <div className="mt-3 flex items-start space-x-2 rounded-md bg-red-50 p-3 text-sm text-red-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <div>
                      <p className="font-medium">Content violates style constraints:</p>
                      <ul className="mt-1 list-disc list-inside space-y-1">
                        {exceedsMaxLength && <li>Content exceeds maximum length</li>}
                        {hasUnsupportedEmojis && <li>Style doesn't allow emojis</li>}
                        {hasUnsupportedHashtags && <li>Style doesn't allow hashtags</li>}
                      </ul>
                    </div>
                  </div>
                )}
              </div>

              {/* Response Style Selection */}
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="mb-3 font-medium text-gray-900">Response Style</h3>
                <select
                  value={selectedStyleId}
                  onChange={(e) => applyResponseStyle(e.target.value)}
                  className="w-full rounded border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">No style selected</option>
                  {responseStyles.map((style) => (
                    <option key={style.id} value={style.id}>
                      {style.name}
                    </option>
                  ))}
                </select>
                
                {selectedStyle && (
                  <div className="mt-3 rounded border border-gray-100 bg-gray-50 p-3 text-sm">
                    <p className="font-medium text-gray-700">{selectedStyle.name}</p>
                    <p className="mt-1 text-gray-600">{selectedStyle.persona}</p>
                    <div className="mt-2">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Rules:</p>
                      <ul className="mt-1 space-y-1">
                        {selectedStyle.rules.slice(0, 3).map((rule, index) => (
                          <li key={index} className="text-xs text-gray-600">• {rule}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>

              {/* Quality Scores */}
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="mb-3 font-medium text-gray-900">Quality Scores</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Toxicity</span>
                    <div className="flex items-center space-x-2">
                      <div className="h-2 w-20 bg-gray-200 rounded-full overflow-hidden">
                        <div 
                          className={`h-full ${approvalItem.toxicityScore > 0.7 ? 'bg-red-500' : approvalItem.toxicityScore > 0.4 ? 'bg-yellow-500' : 'bg-green-500'}`}
                          style={{ width: `${approvalItem.toxicityScore * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium">{Math.round(approvalItem.toxicityScore * 100)}%</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Quality</span>
                    <div className="flex items-center space-x-2">
                      <div className="h-2 w-20 bg-gray-200 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-blue-500"
                          style={{ width: `${approvalItem.qualityScore * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium">{Math.round(approvalItem.qualityScore * 100)}%</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Similarity</span>
                    <div className="flex items-center space-x-2">
                      <div className="h-2 w-20 bg-gray-200 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-purple-500"
                          style={{ width: `${approvalItem.similarityScore * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium">{Math.round(approvalItem.similarityScore * 100)}%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Scheduling */}
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="mb-3 font-medium text-gray-900">Scheduling</h3>
                <div className="flex items-center space-x-3">
                  <Clock className="h-4 w-4 text-gray-400" />
                  <input
                    type="datetime-local"
                    value={scheduledTime}
                    onChange={(e) => setScheduledTime(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                    className="rounded border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                {scheduledTime && (
                  <p className="mt-2 text-xs text-gray-500">
                    Scheduled for {format(new Date(scheduledTime), 'PPP p')}
                  </p>
                )}
              </div>

              {/* Notes */}
              <div className="rounded-lg border border-gray-200 p-4">
                <h3 className="mb-3 font-medium text-gray-900">Notes</h3>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded border border-gray-300 p-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  rows={3}
                  placeholder="Add notes or feedback..."
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 bg-gray-50 px-6 py-4">
            <div className="flex justify-between space-x-3">
              <button
                onClick={handleDeny}
                disabled={loading}
                className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50"
              >
                Deny
              </button>
              
              <div className="flex space-x-3">
                <button
                  onClick={handleSave}
                  disabled={loading}
                  className="flex items-center space-x-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  <span>Save</span>
                </button>
                
                {scheduledTime ? (
                  <button
                    onClick={handleSchedule}
                    disabled={loading}
                    className="flex items-center space-x-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
                  >
                    <Clock className="h-4 w-4" />
                    <span>Schedule</span>
                  </button>
                ) : (
                  <button
                    onClick={handleApprove}
                    disabled={loading}
                    className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50"
                  >
                    Approve Now
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
