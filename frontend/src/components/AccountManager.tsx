import React, { useState, useEffect } from 'react'
import { User, Settings, Shield, Eye, EyeOff, Plus, Edit2, Trash2, Save, X } from 'lucide-react'
import { format } from 'date-fns'
import { useToast } from './ToastProvider'
import Loading from './Loading'
import Alert from './Alert'

interface Account {
  id: string
  platform: string
  username: string
  status: 'active' | 'inactive' | 'suspended' | 'maintenance'
  proxyId?: string
  hitlLevel: 'off' | 'soft' | 'medium' | 'strict'
  createdAt: string
  updatedAt: string
}

export default function AccountManager() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [formData, setFormData] = useState<Partial<Account>>({})
  const toast = useToast()
  const [filters, setFilters] = useState({ q: '', status: '', hitlLevel: '', platform: '' })
  const [page, setPage] = useState(1)
  const pageSize = 10
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Fetch when page or filters change
  useEffect(() => {
    fetchAccounts()
  }, [page, filters])

  const [totalCount, setTotalCount] = useState(0)

  const fetchAccounts = async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      params.set('paged', 'true')
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))
      if (filters.q) params.set('q', filters.q)
      if (filters.status) params.set('status', filters.status)
      if (filters.hitlLevel) params.set('hitlLevel', filters.hitlLevel)
      if (filters.platform) params.set('platform', filters.platform)

      const response = await fetch(`/api/hitl/accounts?${params.toString()}`)
      const data = await response.json()
      if (Array.isArray(data)) {
        setAccounts(data)
        setTotalCount(data.length)
      } else {
        setAccounts(data.items || [])
        setTotalCount(data.total || 0)
      }
      setErrorMsg(null)
    } catch (error) {
      console.error('Failed to fetch accounts:', error)
      setAccounts([])
      setTotalCount(0)
      setErrorMsg('Failed to fetch accounts.')
    } finally {
      setLoading(false)
    }
  }

  // Reset to first page when filters change
  useEffect(() => {
    setPage(1)
  }, [filters.q, filters.status, filters.hitlLevel, filters.platform])

  const saveAccount = async (account: Account) => {
    try {
      const exists = accounts.some(a => a.id === account.id)
      const method = exists ? 'PUT' : 'POST'
      const url = exists ? `/api/hitl/accounts/${account.id}` : '/api/hitl/accounts'
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(account)
      })
      
      if (response.ok) {
        fetchAccounts()
        setEditingAccount(null)
        setShowAddForm(false)
        setFormData({})
        toast.success(method === 'POST' ? 'Account created.' : 'Account updated.')
      } else {
        const text = await response.text()
        console.error('Failed to save account', text)
        toast.error(`Failed to save account${text ? `: ${text}` : ''}`)
      }
    } catch (error) {
      console.error('Error saving account:', error)
      toast.error('Error saving account.')
    }
  }

  const deleteAccount = async (accountId: string) => {
    if (!confirm('Are you sure you want to delete this account?')) return
    
    try {
      const response = await fetch(`/api/hitl/accounts/${accountId}`, {
        method: 'DELETE'
      })
      
      if (response.ok) {
        fetchAccounts()
        toast.success('Account deleted.')
      } else {
        const text = await response.text()
        console.error('Failed to delete account', text)
        toast.error(`Failed to delete account${text ? `: ${text}` : ''}`)
      }
    } catch (error) {
      console.error('Error deleting account:', error)
      toast.error('Error deleting account.')
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-100 text-green-800'
      case 'inactive': return 'bg-gray-100 text-gray-800'
      case 'suspended': return 'bg-red-100 text-red-800'
      case 'maintenance': return 'bg-yellow-100 text-yellow-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  const getHitlLevelColor = (level: string) => {
    switch (level) {
      case 'off': return 'bg-red-100 text-red-800'
      case 'soft': return 'bg-yellow-100 text-yellow-800'
      case 'medium': return 'bg-blue-100 text-blue-800'
      case 'strict': return 'bg-purple-100 text-purple-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  const getHitlLevelDescription = (level: string) => {
    switch (level) {
      case 'off': return 'No human approval required'
      case 'soft': return 'High-risk actions require approval'
      case 'medium': return 'Most actions require approval'
      case 'strict': return 'All actions require approval'
      default: return 'Unknown level'
    }
  }

  const startEdit = (account: Account) => {
    setEditingAccount(account)
    setFormData({ ...account })
  }

  const startAdd = () => {
    setShowAddForm(true)
    setFormData({
      id: `new_${Date.now()}`,
      platform: 'instagram',
      status: 'active',
      hitlLevel: 'medium'
    })
  }

  const cancelEdit = () => {
    setEditingAccount(null)
    setShowAddForm(false)
    setFormData({})
  }

  const handleSave = () => {
    if (!formData.username?.trim()) {
      toast.error('Username is required.')
      return
    }
    
    const accountToSave = {
      id: formData.id || `acc_${Date.now()}`,
      platform: formData.platform || 'instagram',
      username: formData.username,
      status: formData.status || 'active',
      proxyId: formData.proxyId || undefined,
      hitlLevel: formData.hitlLevel || 'medium',
      createdAt: formData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as Account

    saveAccount(accountToSave)
  }

  if (loading) {
    return <Loading title="Account Management" rows={3} cardHeightClass="h-16" />
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Account Management</h1>
        <button
          onClick={startAdd}
          className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          <span>Add Account</span>
        </button>
      </div>

      {/* Inline error banner for fetch failures */}
      {errorMsg && (
        <div className="mb-4">
          <Alert type="error" message={errorMsg} onClose={() => setErrorMsg(null)} />
        </div>
      )}

      {/* Add/Edit Form */}
      {(showAddForm || editingAccount) && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">
              {showAddForm ? 'Add New Account' : 'Edit Account'}
            </h3>
            <button
              onClick={cancelEdit}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Username *
              </label>
              <input
                type="text"
                value={formData.username || ''}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                placeholder="Enter username"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Platform
              </label>
              <select
                value={formData.platform || 'instagram'}
                onChange={(e) => setFormData({ ...formData, platform: e.target.value })}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="instagram">Instagram</option>
                <option value="twitter">Twitter</option>
                <option value="facebook">Facebook</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Status
              </label>
              <select
                value={formData.status || 'active'}
                onChange={(e) => setFormData({ ...formData, status: e.target.value as Account['status'] })}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="suspended">Suspended</option>
                <option value="maintenance">Maintenance</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                HITL Level
              </label>
              <select
                value={formData.hitlLevel || 'medium'}
                onChange={(e) => setFormData({ ...formData, hitlLevel: e.target.value as Account['hitlLevel'] })}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="off">Off - No approval required</option>
                <option value="soft">Soft - High-risk only</option>
                <option value="medium">Medium - Most actions</option>
                <option value="strict">Strict - All actions</option>
              </select>
            </div>
            
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Proxy ID (optional)
              </label>
              <input
                type="text"
                value={formData.proxyId || ''}
                onChange={(e) => setFormData({ ...formData, proxyId: e.target.value })}
                className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                placeholder="Enter proxy ID"
              />
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

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-100 p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            type="text"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="Search @username"
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          />
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="suspended">Suspended</option>
            <option value="maintenance">Maintenance</option>
          </select>
          <select
            value={filters.hitlLevel}
            onChange={(e) => setFilters({ ...filters, hitlLevel: e.target.value })}
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All HITL levels</option>
            <option value="off">Off</option>
            <option value="soft">Soft</option>
            <option value="medium">Medium</option>
            <option value="strict">Strict</option>
          </select>
          <select
            value={filters.platform}
            onChange={(e) => setFilters({ ...filters, platform: e.target.value })}
            className="w-full p-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All platforms</option>
            <option value="instagram">Instagram</option>
            <option value="twitter">Twitter</option>
            <option value="facebook">Facebook</option>
          </select>
        </div>
      </div>

      {/* Accounts List */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {accounts.length === 0 ? (
          <div className="text-center py-12">
            <User className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No accounts configured</h3>
            <p className="text-gray-600 mb-4">Add your first bot account to get started.</p>
            <button
              onClick={startAdd}
              className="inline-flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              <span>Add Account</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Account
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    HITL Level
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Proxy
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Updated
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {accounts.map((account) => (
                  <tr key={account.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <User className="h-5 w-5 text-gray-400 mr-3" />
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            @{account.username}
                          </div>
                          <div className="text-sm text-gray-500 capitalize">
                            {account.platform}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${getStatusColor(account.status)}`}>
                        {account.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center space-x-2">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${getHitlLevelColor(account.hitlLevel)}`}>
                          {account.hitlLevel}
                        </span>
                        <div className="text-xs text-gray-500" title={getHitlLevelDescription(account.hitlLevel)}>
                          <Shield className="h-3 w-3" />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {account.proxyId || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {format(new Date(account.updatedAt), 'MMM d, HH:mm')}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <div className="flex space-x-2">
                        <button
                          onClick={() => startEdit(account)}
                          className="text-blue-600 hover:text-blue-900 p-1 rounded hover:bg-blue-50"
                          title="Edit account"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => deleteAccount(account.id)}
                          className="text-red-600 hover:text-red-900 p-1 rounded hover:bg-red-50"
                          title="Delete account"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
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
