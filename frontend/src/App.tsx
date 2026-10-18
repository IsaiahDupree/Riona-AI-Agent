import React, { useState } from 'react'
import { Activity, CheckSquare, Play, Settings, User, MessageSquare, Menu } from 'lucide-react'
import ModerationInbox from './components/ModerationInbox'
import RunViewer from './components/RunViewer'
import AccountManager from './components/AccountManager'
import StylesEditor from './components/StylesEditor'

type View = 'moderation' | 'runs' | 'accounts' | 'styles'

function App() {
  const [activeView, setActiveView] = useState<View>('moderation')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const navigation = [
    { key: 'moderation', label: 'Moderation', icon: CheckSquare },
    { key: 'runs', label: 'Runs', icon: Play },
    { key: 'accounts', label: 'Accounts', icon: User },
    { key: 'styles', label: 'Styles', icon: MessageSquare },
  ] as const

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-30 bg-white shadow-sm">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center space-x-2">
            <Activity className="h-6 w-6 text-blue-600" />
            <h1 className="text-lg font-bold text-gray-900">Riona HITL</h1>
          </div>
          <button onClick={() => setSidebarOpen(true)} className="p-2 rounded hover:bg-gray-100" aria-label="Open menu">
            <Menu className="h-6 w-6 text-gray-700" />
          </button>
        </div>
      </div>

      {/* Sidebar */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40" onClick={() => setSidebarOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
        </div>
      )}
      <div
        className={`fixed lg:static z-50 inset-y-0 left-0 w-64 bg-white shadow-sm transform transition-transform duration-200 ease-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
      >
        <div className="p-6 hidden lg:block">
          <div className="flex items-center space-x-2">
            <Activity className="h-8 w-8 text-blue-600" />
            <h1 className="text-xl font-bold text-gray-900">Riona HITL</h1>
          </div>
        </div>
        <nav className="mt-6">
          {navigation.map((item) => {
            const Icon = item.icon
            const isActive = activeView === (item.key as View)
            return (
              <button
                key={item.key}
                onClick={() => { setActiveView(item.key as View); setSidebarOpen(false) }}
                className={`w-full flex items-center space-x-3 px-6 py-3 text-left hover:bg-gray-50 ${
                  isActive ? 'bg-blue-50 border-r-2 border-blue-600 text-blue-700' : 'text-gray-700'
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="font-medium">{item.label}</span>
              </button>
            )
          })}
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden lg:pl-0 pt-14 lg:pt-0">
        {activeView === 'moderation' && <ModerationInbox />}
        {activeView === 'runs' && <RunViewer />}
        {activeView === 'accounts' && <AccountManager />}
        {activeView === 'styles' && <StylesEditor />}
      </div>
    </div>
  )
}

export default App
