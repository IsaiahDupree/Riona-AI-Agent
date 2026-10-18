import React, { useState, useEffect } from 'react'
import { Play, CheckCircle, XCircle, Clock, ExternalLink, FileText, Code, Activity, Calendar, RefreshCw, Filter } from 'lucide-react'
import { format } from 'date-fns'
import { useToast } from './ToastProvider'
import Loading from './Loading'
import Alert from './Alert'

interface TraceRecord {
  runId: string
  jobId?: string
  action: string
  target?: {
    username?: string
    postId?: string
    permalink?: string
  }
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  startedAt: string
  endedAt?: string
  durationMs?: number
  build: {
    commit: string
    branch: string
    version: string
    node: string
  }
  links: {
    docs?: Array<{ title?: string; url: string }>
    code?: Array<{ title?: string; url: string }>
    logs?: { live?: string; tail?: string }
    artifacts?: Array<{ title?: string; url: string }>
    scheduler?: { pm2?: string; windows?: string }
  }
  steps: Array<{
    stepId: string
    name: string
    status: 'ok' | 'warn' | 'error'
    ms?: number
    notes?: string
  }>
  error?: {
    message: string
    code?: string
    stack?: string
  } | null
  metrics?: Record<string, number>
}

export default function RunViewer() {
  const [runs, setRuns] = useState<TraceRecord[]>([])
  const [selectedRun, setSelectedRun] = useState<TraceRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [limit, setLimit] = useState(50)
  const [filters, setFilters] = useState({ q: '', status: '' })
  const [page, setPage] = useState(1)
  const pageSize = 10
  const toast = useToast()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [account, setAccount] = useState<any | null>(null)
  const [savingHitl, setSavingHitl] = useState(false)

  useEffect(() => {
    fetchRuns()
  }, [])

  const fetchRuns = async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/trace/recent?limit=${limit}`)
      const data = await response.json()
      setRuns(data)
      setErrorMsg(null)
    } catch (error) {
      console.error('Failed to fetch runs:', error)
      setRuns([])
      toast.error('Failed to fetch runs.')
      setErrorMsg('Failed to fetch runs.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Reset page when filters or limit change
    setPage(1)
  }, [filters.q, filters.status, limit])

  // Auto-refresh runs while any are active (queued/running)
  useEffect(() => {
    const hasActive = runs.some(r => r.status === 'queued' || r.status === 'running')
    if (!hasActive) return
    const id = setInterval(() => {
      fetchRuns()
    }, 5000)
    return () => clearInterval(id)
  }, [runs])

  // Auto-refresh selected run details until it reaches a terminal state
  useEffect(() => {
    if (!selectedRun) return
    const terminal = selectedRun.status === 'succeeded' || selectedRun.status === 'failed'
    if (terminal) return
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/trace/runs/${selectedRun.runId}`)
        if (res.ok) {
          const full = await res.json()
          setSelectedRun(full)
          if (full.status === 'succeeded' || full.status === 'failed') {
            clearInterval(id)
          }
        }
      } catch {}
    }, 3000)
    return () => clearInterval(id)
  }, [selectedRun?.runId, selectedRun?.status])

  const filtered = React.useMemo(() => {
    const q = filters.q.trim().toLowerCase()
    return runs.filter((r) => {
      if (filters.status && r.status !== (filters.status as any)) return false
      if (q) {
        const action = (r.action || '').toLowerCase()
        const user = (r.target?.username || '').toLowerCase()
        const runId = (r.runId || '').toLowerCase()
        if (!action.includes(q) && !user.includes(q) && !runId.includes(q)) return false
      }
      return true
    })
  }, [runs, filters])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const paged = React.useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, currentPage])

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'succeeded': return <CheckCircle className="h-5 w-5 text-green-500" />
      case 'failed': return <XCircle className="h-5 w-5 text-red-500" />
      case 'running': return <Clock className="h-5 w-5 text-blue-500 animate-spin" />
      default: return <Clock className="h-5 w-5 text-gray-400" />
    }
  }

  const getStepIcon = (status: string) => {
    switch (status) {
      case 'ok': return <CheckCircle className="h-4 w-4 text-green-500" />
      case 'warn': return <Clock className="h-4 w-4 text-yellow-500" />
      case 'error': return <XCircle className="h-4 w-4 text-red-500" />
      default: return <Clock className="h-4 w-4 text-gray-400" />
    }
  }

  const formatDuration = (ms?: number) => {
    if (!ms) return '-'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const handleSelect = async (run: TraceRecord) => {
    setSelectedRun(run)
    try {
      setDetailsLoading(true)
      const res = await fetch(`/api/trace/runs/${run.runId}`)
      if (res.ok) {
        const full = await res.json()
        setSelectedRun(full)
        // Fetch account for quick HITL toggle
        const username = full?.target?.username
        if (username) {
          try {
            const q = encodeURIComponent(username)
            const accRes = await fetch(`/api/hitl/accounts?q=${q}&platform=instagram`)
            if (accRes.ok) {
              const data = await accRes.json()
              const rows = Array.isArray(data) ? data : (data.items || [])
              setAccount(rows.find((a: any) => (a.username || '').toLowerCase() === String(username).toLowerCase()) || null)
            }
          } catch {}
        } else {
          setAccount(null)
        }
      } else {
        toast.error('Failed to load run details.')
      }
    } catch (e) {
      console.error('Failed to load run details', e)
      toast.error('Failed to load run details.')
    } finally {
      setDetailsLoading(false)
    }
  }

  const updateHitlLevel = async (level: 'off' | 'soft' | 'medium' | 'strict') => {
    if (!selectedRun?.target?.username) return
    try {
      setSavingHitl(true)
      const username = selectedRun.target.username
      let current = account
      // If no account record, create one quickly
      if (!current) {
        const newAcc = {
          id: `acc_${username}`,
          platform: 'instagram',
          username,
          status: 'active',
          hitlLevel: level
        }
        const createRes = await fetch('/api/hitl/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newAcc) })
        if (!createRes.ok) {
          const t = await createRes.text()
          toast.error(`Create account failed${t ? `: ${t}` : ''}`)
          return
        }
        current = await createRes.json()
        setAccount(current)
        toast.success('Account created')
      } else if (current.hitlLevel !== level) {
        const updRes = await fetch(`/api/hitl/accounts/${current.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hitlLevel: level }) })
        if (!updRes.ok) {
          const t = await updRes.text()
          toast.error(`Update failed${t ? `: ${t}` : ''}`)
          return
        }
        const updated = await updRes.json()
        setAccount(updated)
        toast.success('HITL level updated')
      }
    } catch (e) {
      console.error('Failed to update HITL level', e)
      toast.error('Failed to update HITL level')
    } finally {
      setSavingHitl(false)
    }
  }

  const startRunDemo = async () => {
    try {
      const res = await fetch('/api/trace/runs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'instagram_automation', target: { username: 'demo_user' } })
      })
      if (res.ok) {
        const data = await res.json()
        toast.success(`Started run ${data.runId}`)
        // refresh soon to show first step, then again to show completion
        setTimeout(() => fetchRuns(), 500)
        setTimeout(() => fetchRuns(), 1800)
      } else {
        const text = await res.text()
        toast.error(`Failed to start run${text ? `: ${text}` : ''}`)
      }
    } catch (e) {
      console.error('Failed to start run', e)
      toast.error('Failed to start run.')
    }
  }

  const startRunFull = async () => {
    try {
      const res = await fetch('/api/trace/runs/start-full', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        toast.success(`Started full run ${data.runId}`)
        setTimeout(() => fetchRuns(), 1000)
        setTimeout(() => fetchRuns(), 3000)
      } else {
        const text = await res.text()
        toast.error(`Failed to start full run${text ? `: ${text}` : ''}`)
      }
    } catch (e) {
      console.error('Failed to start full run', e)
      toast.error('Failed to start full run.')
    }
  }

  if (loading) {
    return <Loading title="Trace Runs" rows={3} cardHeightClass="h-24" />
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Trace Runs</h1>
        <div className="flex items-center space-x-2 flex-wrap gap-2">
          <div className="flex items-center space-x-2 bg-white border border-gray-200 rounded-md p-2">
            <Filter className="h-4 w-4 text-gray-500" />
            <input
              type="text"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder="Search action, @user, runId"
              className="p-1 outline-none"
            />
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="p-1 border border-gray-200 rounded"
            >
              <option value="">All</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
            </select>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="p-1 border border-gray-200 rounded"
            >
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
          <button
            onClick={startRunDemo}
            className="flex items-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
            title="Start Demo Run"
          >
            <Activity className="h-4 w-4" />
            <span>Start Demo Run</span>
          </button>
          <button
            onClick={startRunFull}
            className="flex items-center space-x-2 px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700"
            title="Start Full Run"
          >
            <Play className="h-4 w-4" />
            <span>Start Full Run</span>
          </button>
          <button
            onClick={fetchRuns}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Runs List */}
        <div className="space-y-4">
          {filtered.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Play className="h-12 w-12 mx-auto mb-4 text-gray-300" />
              <p>No runs found</p>
            </div>
          ) : (
            paged.map((run) => (
              <div
                key={run.runId}
                onClick={() => handleSelect(run)}
                className={`bg-white p-4 rounded-lg shadow cursor-pointer hover:shadow-md transition-shadow ${
                  selectedRun?.runId === run.runId ? 'ring-2 ring-blue-500' : ''
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    {getStatusIcon(run.status)}
                    <span className="font-medium text-gray-900">{run.action}</span>
                  </div>
                  <span className="text-sm text-gray-500">
                    {format(new Date(run.startedAt), 'MMM d, HH:mm')}
                  </span>
                </div>
                <div className="text-sm text-gray-600">
                  <div className="flex justify-between">
                    <span>Duration: {formatDuration(run.durationMs)}</span>
                    <span>Steps: {run.steps ? run.steps.length : '-'}</span>
                  </div>
                  {run.target?.username && (
                    <div className="mt-1">Target: @{run.target.username}</div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Run Details */}
        {selectedRun ? (
          <div className="bg-white rounded-lg shadow p-6 max-h-[calc(100vh-160px)] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Run Details</h3>
              <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                selectedRun.status === 'succeeded' ? 'bg-green-100 text-green-800' :
                selectedRun.status === 'failed' ? 'bg-red-100 text-red-800' :
                'bg-yellow-100 text-yellow-800'
              }`}>
                {selectedRun.status}
              </span>
            </div>

            <div className="space-y-4">
              {detailsLoading && (
                <div className="text-sm text-gray-500">Loading details…</div>
              )}
              {/* Basic Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="font-medium text-gray-700">Run ID:</span>
                  <div className="font-mono text-gray-900">{selectedRun.runId}</div>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Duration:</span>
                  <div className="text-gray-900">{formatDuration(selectedRun.durationMs)}</div>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Branch:</span>
                  <div className="text-gray-900">{selectedRun.build.branch}</div>
                </div>
                <div>
                  <span className="font-medium text-gray-700">Commit:</span>
                  <div className="font-mono text-gray-900">{selectedRun.build.commit}</div>
                </div>
              </div>

              {/* Quick Account HITL toggle */}
              {selectedRun.target?.username && (
                <div className="bg-gray-50 border border-gray-200 rounded p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm">
                      <div className="font-medium text-gray-800">Account HITL</div>
                      <div className="text-gray-600">@{selectedRun.target.username}</div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <select
                        value={account?.hitlLevel || 'medium'}
                        onChange={(e) => updateHitlLevel(e.target.value as any)}
                        disabled={savingHitl}
                        className="text-sm p-2 border border-gray-300 rounded"
                        title="Human-in-the-loop level"
                      >
                        <option value="off">Off</option>
                        <option value="soft">Soft</option>
                        <option value="medium">Medium</option>
                        <option value="strict">Strict</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Links */}
              <div>
                <h4 className="font-medium text-gray-700 mb-2">Quick Links</h4>
                <div className="flex flex-wrap gap-2">
                  {selectedRun.links.docs?.map((link, i) => (
                    <a
                      key={i}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center space-x-1 px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded hover:bg-blue-100"
                    >
                      <FileText className="h-3 w-3" />
                      <span>{link.title || 'Docs'}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ))}
                  {selectedRun.links.code?.map((link, i) => (
                    <a
                      key={i}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center space-x-1 px-2 py-1 bg-gray-50 text-gray-700 text-xs rounded hover:bg-gray-100"
                    >
                      <Code className="h-3 w-3" />
                      <span>{link.title || 'Code'}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ))}
                  {selectedRun.links.logs?.tail && (
                    <a
                      href={selectedRun.links.logs.tail}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center space-x-1 px-2 py-1 bg-green-50 text-green-700 text-xs rounded hover:bg-green-100"
                    >
                      <Activity className="h-3 w-3" />
                      <span>Logs</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>

              {/* Artifacts */}
              {selectedRun?.links?.artifacts && selectedRun.links.artifacts.length > 0 && (
                <div>
                  <h4 className="font-medium text-gray-700 mb-2">Artifacts</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {selectedRun.links.artifacts.map((a, i) => (
                      <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="block group">
                        <div className="w-full h-36 sm:h-40 md:h-48 bg-gray-100 rounded overflow-hidden">
                          <img src={a.url} alt={a.title || `artifact-${i}`} className="w-full h-full object-cover group-hover:opacity-90" />
                        </div>
                        <div className="mt-1 text-xs text-gray-600 truncate" title={a.title || a.url}>{a.title || a.url}</div>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Steps */}
              <div>
                <h4 className="font-medium text-gray-700 mb-2">Execution Steps</h4>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {(selectedRun.steps || []).map((step) => (
                    <div key={step.stepId} className="p-2 bg-gray-50 rounded">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          {getStepIcon(step.status)}
                          <span className="text-sm font-medium text-gray-900">{step.name}</span>
                        </div>
                        <span className="text-xs text-gray-500">{formatDuration(step.ms)}</span>
                      </div>
                      {step.notes && (
                        <div className="mt-1 text-xs text-gray-600 break-words">
                          {(() => { try { const obj = JSON.parse(step.notes); return <code className="text-gray-700">{JSON.stringify(obj)}</code> } catch { return <span>{step.notes}</span> } })()}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Error Details */}
              {selectedRun.error && (
                <div>
                  <h4 className="font-medium text-red-700 mb-2">Error Details</h4>
                  <div className="bg-red-50 border border-red-200 rounded p-3">
                    <div className="text-sm text-red-800">{selectedRun.error.message}</div>
                    {selectedRun.error.stack && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm text-red-700">Stack Trace</summary>
                        <pre className="mt-1 text-xs text-red-600 overflow-x-auto whitespace-pre-wrap">
                          {selectedRun.error.stack}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              )}

              {/* Metrics */}
              {selectedRun.metrics && Object.keys(selectedRun.metrics).length > 0 && (
                <div>
                  <h4 className="font-medium text-gray-700 mb-2">Metrics</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(selectedRun.metrics).map(([key, value]) => (
                      <div key={key} className="bg-gray-50 rounded p-2">
                        <div className="text-xs text-gray-600 uppercase tracking-wide">{key}</div>
                        <div className="text-lg font-semibold text-gray-900">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-gray-50 rounded-lg p-8 text-center text-gray-500">
            <Calendar className="h-12 w-12 mx-auto mb-4 text-gray-300" />
            <p>Select a run to view details</p>
          </div>
        )}
      </div>
      {filtered.length > 0 && (
        <div className="flex items-center justify-between p-4">
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
      )}
    </div>
  )
}
