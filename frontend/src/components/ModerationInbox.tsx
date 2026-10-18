import React, { useState, useEffect } from 'react'
import { CheckCircle, XCircle, Edit, Clock, AlertTriangle, User, MessageSquare } from 'lucide-react'
import { format } from 'date-fns'
import { useToast } from './ToastProvider'
import Loading from './Loading'
import Alert from './Alert'

interface StyleOption { id: string; name: string }

interface ModerationItem {
  id: string
  interaction: {
    id: string
    accountId: string
    type: 'comment' | 'like' | 'post'
    target: {
      username: string
      postId?: string
      permalink?: string
    }
    proposed: {
      text?: string
      styleId?: string
      reasons?: string[]
    }
    decided: {
      text?: string
      styleId?: string
    }
    state: string
    scores: {
      toxicity?: number
      similarity?: number
      quality?: number
    }
    scheduleAt?: string
    createdAt: string
    updatedAt: string
  }
  state: string
  notes?: string
  expiresAt?: string
  createdAt: string
  updatedAt: string
}

export default function ModerationInbox() {
  const [items, setItems] = useState<ModerationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState<ModerationItem | null>(null)
  const [filters, setFilters] = useState({ q: '', type: '', accountId: '', state: 'pending_review' })
  const [page, setPage] = useState(1)
  const pageSize = 10
  const toast = useToast()
  const [styles, setStyles] = useState<StyleOption[]>([])
  const [reviewText, setReviewText] = useState('')
  const [reviewStyleId, setReviewStyleId] = useState('')
  const [scheduleAt, setScheduleAt] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    fetchModerationItems()
  }, [])

  useEffect(() => {
    // Fetch styles for selector
    ;(async () => {
      try {
        const res = await fetch('/api/hitl/styles')
        const data = await res.json()
        const opts: StyleOption[] = (Array.isArray(data) ? data : data.items || []).map((s: any) => ({ id: s.id, name: s.name }))
        setStyles(opts)
      } catch (e) {
        console.error('Failed to load styles', e)
      }
    })()
  }, [])

  const fetchModerationItems = async () => {
    try {
      setLoading(true)
      const state = filters.state || 'pending_review'
      const response = await fetch(`/api/hitl/moderation/items?state=${encodeURIComponent(state)}${filters.accountId ? `&accountId=${encodeURIComponent(filters.accountId)}` : ''}`)
      const data = await response.json()
      setItems(data)
      setErrorMsg(null)
    } catch (error) {
      console.error('Failed to fetch moderation items:', error)
      setItems([])
      setErrorMsg('Failed to fetch moderation items.')
    } finally {
      setLoading(false)
    }
  }

  const filtered = React.useMemo(() => {
    const q = filters.q.trim().toLowerCase()
    return items.filter((it) => {
      if (filters.type && it.interaction.type !== (filters.type as any)) return false
      if (filters.accountId && it.interaction.accountId !== filters.accountId) return false
      if (q) {
        const text = (it.interaction.decided?.text || it.interaction.proposed?.text || '').toLowerCase()
        const user = (it.interaction.target.username || '').toLowerCase()
        if (!text.includes(q) && !user.includes(q)) return false
      }
      return true
    })
  }, [items, filters])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const paged = React.useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, currentPage])

  useEffect(() => {
    setPage(1)
  }, [filters.q, filters.type, filters.accountId, filters.state])

  // When status filter changes, refresh
  useEffect(() => {
    fetchModerationItems()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.state])

  // Initialize review fields when opening modal
  useEffect(() => {
    if (selectedItem) {
      setReviewText(selectedItem.interaction.decided?.text || selectedItem.interaction.proposed?.text || '')
      setReviewStyleId(selectedItem.interaction.decided?.styleId || selectedItem.interaction.proposed?.styleId || '')
      setScheduleAt('')
    }
  }, [selectedItem])

  const handleAction = async (itemId: string, action: 'approve' | 'deny' | 'revise' | 'schedule', data?: any) => {
    try {
      const response = await fetch(`/api/hitl/moderation/${itemId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data || {})
      })
      
      if (response.ok) {
        // Refresh the list
        fetchModerationItems()
        setSelectedItem(null)
        toast.success(`Item ${action}d successfully.`)
      } else {
        const text = await response.text()
        console.error(`Failed to ${action} item`, text)
        toast.error(`Failed to ${action} item${text ? `: ${text}` : ''}`)
      }
    } catch (error) {
      console.error(`Error ${action}ing item:`, error)
      toast.error(`Error ${action}ing item.`)
    }
  }

  // Approve + Execute Now: approve the approval item, then call backend execute endpoint
  const approveAndExecute = async (interactionId: string, approvalId: string) => {
    try {
      // Approve first
      const approveRes = await fetch(`/api/hitl/moderation/${approvalId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      if (!approveRes.ok) {
        const t = await approveRes.text()
        toast.error(`Approve failed${t ? `: ${t}` : ''}`)
        return
      }
      // Execute now
      const execRes = await fetch(`/api/hitl/interactions/${interactionId}/execute`, { method: 'POST' })
      if (execRes.ok) {
        const data = await execRes.json()
        toast.success(`Execution started. Run ${data.runId}`)
        fetchModerationItems()
        // Briefly poll for completion to auto-update UI
        ;(async () => {
          const deadline = Date.now() + 60_000 // up to 60s
          let lastFailureNotes: string | null = null
          while (Date.now() < deadline) {
            try {
              const res = await fetch('/api/hitl/moderation/items?state=pending_review')
              const arr: ModerationItem[] = await res.json()
              const found = arr.find((it) => it.id === approvalId)
              if (!found) {
                toast.success('Execution completed and item removed from moderation.')
                // Final refresh and stop
                fetchModerationItems()
                break
              }
              if (found?.notes && found.notes !== lastFailureNotes) {
                lastFailureNotes = found.notes
                toast.warning(`Execution failed or needs retry: ${found.notes}`)
                // Stop polling; item stays pending_review for moderator action
                break
              }
            } catch (e) {
              // Ignore transient errors and continue polling
            }
            await new Promise((r) => setTimeout(r, 5000))
          }
        })()
      } else {
        const t = await execRes.text()
        toast.error(`Failed to start execution${t ? `: ${t}` : ''}`)
      }
    } catch (e) {
      console.error('approveAndExecute error', e)
      toast.error('Error starting execution')
    }
  }

  const getToxicityColor = (score?: number) => {
    if (!score) return 'text-gray-400'
    if (score < 0.3) return 'text-green-600'
    if (score < 0.6) return 'text-yellow-600'
    return 'text-red-600'
  }

  const scoreBadge = (label: string, value?: number, color: 'green' | 'blue' | 'purple' | 'yellow' | 'red' | 'gray' = 'gray') => {
    const palette: any = {
      green: 'bg-green-50 text-green-700',
      blue: 'bg-blue-50 text-blue-700',
      purple: 'bg-purple-50 text-purple-700',
      yellow: 'bg-yellow-50 text-yellow-700',
      red: 'bg-red-50 text-red-700',
      gray: 'bg-gray-50 text-gray-700',
    }
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${palette[color]}`}>{label}: {value !== undefined ? value.toFixed(2) : '-'}</span>
    )
  }

  if (loading) {
    return <Loading title="Moderation Inbox" rows={3} cardHeightClass="h-20" />
  }

  return (
    <div className="p-6">
      {/* Toasts are rendered globally by ToastProvider */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Moderation Inbox</h1>
        <div className="flex items-center space-x-2 text-sm text-gray-600">
          <AlertTriangle className="h-4 w-4" />
          <span>{filtered.length} {filters.state.replace('_', ' ')}</span>
        </div>
      </div>

      {/* Status Tabs */}
      <div className="flex items-center gap-2 mb-4">
        {[
          { key: 'pending_review', label: 'Pending' },
          { key: 'approved', label: 'Approved' },
          { key: 'scheduled', label: 'Scheduled' },
          { key: 'executed', label: 'Completed' },
          { key: 'failed', label: 'Failed' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilters({ ...filters, state: tab.key })}
            className={`px-3 py-1.5 rounded-md border text-sm ${filters.state === tab.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Inline error banner for fetch failures */}
      {errorMsg && (
        <div className="mb-4">
          <Alert type="error" message={errorMsg} onClose={() => setErrorMsg(null)} />
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-100 p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            type="text"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="Search text or @username"
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          />
          <select
            value={filters.type}
            onChange={(e) => setFilters({ ...filters, type: e.target.value })}
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All types</option>
            <option value="comment">Comment</option>
            <option value="like">Like</option>
            <option value="post">Post</option>
          </select>
          <input
            type="text"
            value={filters.accountId}
            onChange={(e) => setFilters({ ...filters, accountId: e.target.value })}
            placeholder="Filter by accountId"
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            onClick={fetchModerationItems}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">All caught up!</h3>
          <p className="text-gray-600">No items pending moderation at the moment.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full table-fixed divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Account
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Target
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Content
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Scores
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {paged.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <MessageSquare className="h-5 w-5 text-gray-400 mr-2" />
                        <span className="text-sm font-medium text-gray-900 capitalize">
                          {item.interaction.type}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        item.state === 'executed' ? 'bg-green-50 text-green-700' :
                        item.state === 'failed' ? 'bg-red-50 text-red-700' :
                        item.state === 'scheduled' ? 'bg-purple-50 text-purple-700' :
                        item.state === 'approved' ? 'bg-blue-50 text-blue-700' : 'bg-yellow-50 text-yellow-700'
                      }`}>
                        {item.state.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <User className="h-4 w-4 text-gray-400 mr-2" />
                        <span className="text-sm text-gray-900">{item.interaction.accountId}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div
                        className="text-sm text-gray-900 max-w-[260px] truncate"
                        title={`@${item.interaction.target.username}${item.interaction.target.permalink ? ` • ${item.interaction.target.permalink}` : ''}`}
                      >
                        <span>@{item.interaction.target.username}</span>
                        {item.interaction.target.permalink && (
                          <span className="hidden md:inline text-gray-500"> • {item.interaction.target.permalink}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900 max-w-xs truncate">
                        {item.interaction.decided?.text || item.interaction.proposed?.text || '-'}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {scoreBadge('tox', item.interaction.scores?.toxicity, item.interaction.scores?.toxicity !== undefined ? (item.interaction.scores!.toxicity < 0.3 ? 'green' : item.interaction.scores!.toxicity < 0.6 ? 'yellow' : 'red') : 'gray')}
                        {scoreBadge('sim', item.interaction.scores?.similarity, 'blue')}
                        {scoreBadge('qual', item.interaction.scores?.quality, 'purple')}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {format(new Date(item.createdAt), 'MMM d, HH:mm')}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <div className="flex space-x-2">
                        {item.state === 'pending_review' ? (
                          <>
                            <button
                              onClick={() => handleAction(item.id, 'approve')}
                              className="text-green-600 hover:text-green-900 p-1 rounded hover:bg-green-50"
                              title="Approve"
                            >
                              <CheckCircle className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleAction(item.id, 'deny')}
                              className="text-red-600 hover:text-red-900 p-1 rounded hover:bg-red-50"
                              title="Deny"
                            >
                              <XCircle className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => setSelectedItem(item)}
                              className="text-blue-600 hover:text-blue-900 p-1 rounded hover:bg-blue-50"
                              title="Review & Edit"
                            >
                              <Edit className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => approveAndExecute(item.interaction.id, item.id)}
                              className="text-purple-600 hover:text-purple-900 p-1 rounded hover:bg-purple-50"
                              title="Approve + Execute Now"
                            >
                              <Clock className="h-4 w-4" />
                            </button>
                          </>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between p-4 border-t border-gray-100">
            <span className="text-sm text-gray-600">
              Showing {filtered.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}
              –{Math.min(filtered.length, currentPage * pageSize)} of {filtered.length}
            </span>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-50 bg-white hover:bg-gray-50"
              >
                Previous
              </button>
              <span className="text-sm text-gray-700">Page {currentPage} of {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-50 bg-white hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Review Modal */}
      {selectedItem && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Review Interaction</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Content</label>
                  <textarea
                    className="w-full p-2 border border-gray-300 rounded-md"
                    rows={3}
                    value={reviewText}
                    onChange={(e) => setReviewText(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Style</label>
                  <select
                    className="w-full p-2 border border-gray-300 rounded-md"
                    value={reviewStyleId}
                    onChange={(e) => setReviewStyleId(e.target.value)}
                  >
                    <option value="">Default</option>
                    {styles.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Schedule (optional)</label>
                  <input
                    type="datetime-local"
                    className="w-full p-2 border border-gray-300 rounded-md"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <button
                    onClick={() => setSelectedItem(null)}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleAction(selectedItem.id, 'revise', { text: reviewText, styleId: reviewStyleId })}
                    className="px-3 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700"
                  >
                    Revise
                  </button>
                  <button
                    onClick={() => handleAction(selectedItem.id, 'approve')}
                    className="px-3 py-2 text-sm font-medium text-white bg-green-600 border border-transparent rounded-md hover:bg-green-700"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => {
                      if (!scheduleAt) { toast.error('Select a schedule time.'); return }
                      handleAction(selectedItem.id, 'schedule', { runAt: new Date(scheduleAt).toISOString() })
                    }}
                    className="px-3 py-2 text-sm font-medium text-white bg-purple-600 border border-transparent rounded-md hover:bg-purple-700"
                  >
                    Schedule
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
