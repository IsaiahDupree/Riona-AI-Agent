import mongoose from 'mongoose'
import dotenv from 'dotenv'

dotenv.config({ override: true })

async function testDatabaseConnection(): Promise<void> {
  try {
    console.log('🔌 Testing database connection...')
    
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/riona-test'
    console.log(`📡 Connecting to: ${mongoUri.replace(/\/\/.*@/, '//***:***@')}`)
    
    await mongoose.connect(mongoUri)
    console.log('✅ Database connection successful!')
    
    // Test basic operation
    const testCollection = mongoose.connection.db?.collection('test')
    if (testCollection) {
      await testCollection.insertOne({ test: true, timestamp: new Date() })
      console.log('✅ Database write test successful!')
      
      await testCollection.deleteOne({ test: true })
      console.log('✅ Database cleanup successful!')
    }
    
  } catch (error) {
    console.error('❌ Database connection failed:', error instanceof Error ? error.message : String(error))
    console.log('💡 Make sure MongoDB is running or check your MONGODB_URI')
  } finally {
    await mongoose.disconnect()
    console.log('🔌 Database connection closed')
  }
}

if (require.main === module) {
  testDatabaseConnection()
}

export { testDatabaseConnection }
