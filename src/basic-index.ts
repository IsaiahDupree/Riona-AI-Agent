import dotenv from 'dotenv'
import { startBasicServer } from './server/basic-app'

// Load environment variables
dotenv.config({ override: true })

console.log('🤖 Starting Riona Instagram AI Agent - Basic Mode')
console.log('📝 Environment:', process.env.NODE_ENV || 'development')

// Start basic web server if enabled
if (process.env.WEB_SERVER_ENABLED === 'true') {
  startBasicServer()
} else {
  console.log('💡 Web server disabled. Set WEB_SERVER_ENABLED=true to enable.')
}

console.log('✅ Basic setup complete!')
