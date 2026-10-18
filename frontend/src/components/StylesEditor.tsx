import React, { useState, useEffect } from 'react'
import { MessageSquare, Plus, Edit2, Trash2, Save, X, Copy, Palette } from 'lucide-react'
import { format } from 'date-fns'
import { useToast } from './ToastProvider'
import Loading from './Loading'
import Alert from './Alert'

interface ResponseStyle {
  id: string
  name: string
  persona: string
  rules: string[]
  maxLen: number
  emojis: boolean
  hashtags: boolean
  createdAt: string
  updatedAt: string
}

export default function StylesEditor() {
  const [styles, setStyles] = useState<ResponseStyle[]>([])
  const [loading, setLoading] = useState(true)
  const [editingStyle, setEditingStyle] = useState<ResponseStyle | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [formData, setFormData] = useState<Partial<ResponseStyle>>({})
  const toast = useToast()
  const [filters, setFilters] = useState({ q: '' })
  const [page, setPage] = useState(1)
  const pageSize = 10
  const [totalCount, setTotalCount] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    fetchStyles()
  }, [page, filters])

  const fetchStyles = async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      params.set('paged', 'true')
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))
      if (filters.q) params.set('q', filters.q)
      const response = await fetch(`/api/hitl/styles?${params.toString()}`)
      const data = await response.json()
      if (Array.isArray(data)) {
        setStyles(data)
        setTotalCount(data.length)
      } else {
        setStyles(data.items || [])
        setTotalCount(data.total || 0)
      }
      setErrorMsg(null)
    } catch (error) {
      console.error('Failed to fetch styles:', error)
      setStyles([])
      setTotalCount(0)
      setErrorMsg('Failed to fetch styles.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setPage(1)
  }, [filters.q])

  const saveStyle = async (style: ResponseStyle) => {
    try {
      const method = style.id.startsWith('new_') ? 'POST' : 'PUT'
      const url = method === 'POST' ? '/api/hitl/styles' : `/api/hitl/styles/${style.id}`
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(style)
      })
      
      if (response.ok) {
        fetchStyles()
        setEditingStyle(null)
        setShowAddForm(false)
        setFormData({})
        toast.success(method === 'POST' ? 'Style created.' : 'Style updated.')
      } else {
        const text = await response.text()
        console.error('Failed to save style', text)
        toast.error(`Failed to save style${text ? `: ${text}` : ''}`)
      }
    } catch (error) {
      console.error('Error saving style:', error)
      toast.error('Error saving style.')
    }
  }

  const deleteStyle = async (styleId: string) => {
    if (!confirm('Are you sure you want to delete this response style?')) return
    
    try {
      const response = await fetch(`/api/hitl/styles/${styleId}`, {
        method: 'DELETE'
      })
      
      if (response.ok) {
        fetchStyles()
        toast.success('Style deleted.')
      } else {
        const text = await response.text()
        console.error('Failed to delete style', text)
        toast.error(`Failed to delete style${text ? `: ${text}` : ''}`)
      }
    } catch (error) {
      console.error('Error deleting style:', error)
      toast.error('Error deleting style.')
    }
  }

  const duplicateStyle = (style: ResponseStyle) => {
    const newStyle = {
      ...style,
      id: `new_${Date.now()}`,
      name: `${style.name} (Copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    setFormData(newStyle)
    setShowAddForm(true)
  }

  const startEdit = (style: ResponseStyle) => {
    setEditingStyle(style)
    setFormData({ ...style })
  }

  const startAdd = () => {
    setShowAddForm(true)
    setFormData({
      id: `new_${Date.now()}`,
      name: '',
      persona: '',
      rules: [''],
      maxLen: 80,
      emojis: true,
      hashtags: false
    })
  }

  const cancelEdit = () => {
    setEditingStyle(null)
    setShowAddForm(false)
    setFormData({})
  }

  const handleSave = () => {
    if (!formData.name?.trim()) {
      toast.error('Style name is required.')
      return
    }
    
    if (!formData.persona?.trim()) {
      toast.error('Persona description is required.')
      return
    }

    const filteredRules = (formData.rules || []).filter(rule => rule.trim() !== '')
    if (filteredRules.length === 0) {
      toast.error('At least one rule is required.')
      return
    }
    
    const styleToSave = {
      id: formData.id || `style_${Date.now()}`,
      name: formData.name,
      persona: formData.persona,
      rules: filteredRules,
      maxLen: formData.maxLen || 80,
      emojis: formData.emojis ?? true,
      hashtags: formData.hashtags ?? false,
      createdAt: formData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as ResponseStyle

    saveStyle(styleToSave)
  }

  const addRule = () => {
    setFormData({
      ...formData,
      rules: [...(formData.rules || []), '']
    })
  }

  const updateRule = (index: number, value: string) => {
    const newRules = [...(formData.rules || [])]
    newRules[index] = value
    setFormData({ ...formData, rules: newRules })
  }

  const removeRule = (index: number) => {
    const newRules = formData.rules?.filter((_, i) => i !== index) || []
    setFormData({ ...formData, rules: newRules })
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-6"></div>
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-32 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (loading) {
    return <Loading title="Response Styles" rows={3} cardHeightClass="h-24" />
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Response Styles</h1>
        <button
          onClick={startAdd}
          className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          <span>Add Style</span>
        </button>
      </div>

      {/* Toasts are rendered globally by ToastProvider */}

      {/* Inline error banner for fetch failures */}
      {errorMsg && (
        <div className="mb-4">
          <Alert type="error" message={errorMsg} onClose={() => setErrorMsg(null)} />
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-100 p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            type="text"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="Search name or persona"
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      {/* Add/Edit Form */}
      {(showAddForm || editingStyle) && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">
              {showAddForm ? 'Create New Style' : 'Edit Style'}
            </h3>
            <button
              onClick={cancelEdit}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Style Name *
                </label>
                <input
                  type="text"
                  value={formData.name || ''}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., Casual & Friendly"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Max Length
                </label>
                <input
                  type="number"
                  value={formData.maxLen || 80}
                  onChange={(e) => setFormData({ ...formData, maxLen: parseInt(e.target.value) })}
                  className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  min="10"
                  max="280"
                />
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Persona Description *
              </label>
              <textarea
                value={formData.persona || ''}
                onChange={(e) => setFormData({ ...formData, persona: e.target.value })}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                rows={2}
                placeholder="Describe the personality and tone of this commenting style..."
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Style Rules *
              </label>
              <div className="space-y-2">
                {(formData.rules || []).map((rule, index) => (
                  <div key={index} className="flex items-center space-x-2">
                    <input
                      type="text"
                      value={rule}
                      onChange={(e) => updateRule(index, e.target.value)}
                      className="flex-1 p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Enter a style rule..."
                    />
                    <button
                      onClick={() => removeRule(index)}
                      className="text-red-600 hover:text-red-800 p-1"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={addRule}
                  className="text-blue-600 hover:text-blue-800 text-sm flex items-center space-x-1"
                >
                  <Plus className="h-3 w-3" />
                  <span>Add Rule</span>
                </button>
              </div>
            </div>
            
            <div className="flex items-center space-x-6">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={formData.emojis ?? true}
                  onChange={(e) => setFormData({ ...formData, emojis: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Allow emojis</span>
              </label>
              
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={formData.hashtags ?? false}
                  onChange={(e) => setFormData({ ...formData, hashtags: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Allow hashtags</span>
              </label>
            </div>
          </div>
          
          <div className="flex justify-end space-x-3 mt-6">
            <button
              onClick={cancelEdit}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
            >
              <Save className="h-4 w-4" />
              <span>Save</span>
            </button>
          </div>
        </div>
      )}

      {/* Styles List */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {styles.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No styles found</h3>
            <p className="text-gray-600 mb-4">Create your first response style.</p>
            <button
              onClick={startAdd}
              className="inline-flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              <span>Add Style</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <tbody className="bg-white divide-y divide-gray-200">
                {styles.map((style) => (
                  <tr key={style.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center space-x-2">
                          <Palette className="h-5 w-5 text-blue-600" />
                          <h3 className="text-lg font-semibold text-gray-900">{style.name}</h3>
                        </div>
                        <div className="flex items-center space-x-1">
                          <button
                            onClick={() => duplicateStyle(style)}
                            className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                            title="Duplicate style"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => startEdit(style)}
                            className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-50"
                            title="Edit style"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => deleteStyle(style.id)}
                            className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-50"
                            title="Delete style"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div>
                          <h4 className="text-sm font-medium text-gray-700 mb-1">Persona</h4>
                          <p className="text-sm text-gray-600">{style.persona}</p>
                        </div>

                        <div>
                          <h4 className="text-sm font-medium text-gray-700 mb-2">Rules</h4>
                          <ul className="text-sm text-gray-600 space-y-1">
                            {style.rules.slice(0, 3).map((rule, index) => (
                              <li key={index} className="flex items-start space-x-2">
                                <span className="text-blue-600 mt-1">•</span>
                                <span>{rule}</span>
                              </li>
                            ))}
                            {style.rules.length > 3 && (
                              <li className="text-gray-400 text-xs">
                                +{style.rules.length - 3} more rules
                              </li>
                            )}
                          </ul>
                        </div>

                        <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                          <div className="flex items-center space-x-4 text-xs text-gray-500">
                            <span>Max: {style.maxLen} chars</span>
                            <span>Emojis: {style.emojis ? '✓' : '✗'}</span>
                            <span>Tags: {style.hashtags ? '✓' : '✗'}</span>
                          </div>
                          <div className="text-xs text-gray-500">
                            Updated {format(new Date(style.updatedAt), 'MMM d')}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between p-4 border-t border-gray-100">
              <span className="text-sm text-gray-600">
                Showing {totalCount === 0 ? 0 : (page - 1) * pageSize + 1}
                –{Math.min(totalCount, page * pageSize)} of {totalCount}
              </span>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-50 bg-white hover:bg-gray-50"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-700">Page {page} of {Math.max(1, Math.ceil(totalCount / pageSize))}</span>
                <button
                  onClick={() => setPage((p) => Math.min(Math.max(1, Math.ceil(totalCount / pageSize)), p + 1))}
                  disabled={page >= Math.max(1, Math.ceil(totalCount / pageSize))}
                  className="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-50 bg-white hover:bg-gray-50"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
