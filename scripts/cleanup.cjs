/**
 * Cleanup test data after load testing
 * 
 * Directly cleans database - no API nonsense
 * 
 * Usage:
 *   npm run cleanup          # Remove test playlists only
 *   npm run cleanup:full     # Remove everything including library and user
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/m3w';
const FULL_CLEANUP = process.argv.includes('--full');

const TEST_USER_ID = 'load-test-user-001';
const TEST_USER_EMAIL = 'loadtest@m3w.local';

async function cleanup() {
  console.log('🧹 M3W Load Test - Cleanup Script');
  console.log('==================================');
  console.log(`Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`Mode: ${FULL_CLEANUP ? 'Full cleanup' : 'Playlists only'}`);
  console.log('');
  
  const client = new Client({ connectionString: DATABASE_URL });
  
  try {
    await client.connect();
    console.log('✅ Database connected\n');
    
    // Delete load test playlists
    console.log('📋 Cleaning up playlists...');
    const playlistResult = await client.query(
      `DELETE FROM playlists WHERE name LIKE 'Load Test Playlist%' RETURNING id`
    );
    console.log(`  ✅ Deleted ${playlistResult.rowCount} playlists`);
    
    if (FULL_CLEANUP) {
      // Delete songs in test library
      console.log('\n🎵 Cleaning up songs...');
      const songResult = await client.query(
        `DELETE FROM songs WHERE "libraryId" IN (
          SELECT id FROM libraries WHERE name = 'Load Test Library'
        ) RETURNING id`
      );
      console.log(`  ✅ Deleted ${songResult.rowCount} songs`);
      
      // Delete test library
      console.log('\n📚 Cleaning up library...');
      const libResult = await client.query(
        `DELETE FROM libraries WHERE name = 'Load Test Library' RETURNING id`
      );
      console.log(`  ✅ Deleted ${libResult.rowCount} libraries`);
      
      // Delete test user
      console.log('\n👤 Cleaning up test user...');
      const userResult = await client.query(
        `DELETE FROM users WHERE id = $1 OR email = $2 RETURNING id`,
        [TEST_USER_ID, TEST_USER_EMAIL]
      );
      console.log(`  ✅ Deleted ${userResult.rowCount} users`);
      
      // Clean up .env.test file
      const envFile = path.join(__dirname, '..', '.env.test');
      if (fs.existsSync(envFile)) {
        fs.unlinkSync(envFile);
        console.log('\n📄 Removed .env.test file');
      }
      
      // Clean up generated test audio
      const testAudio = path.join(__dirname, '..', 'fixtures', 'test-audio.mp3');
      if (fs.existsSync(testAudio)) {
        fs.unlinkSync(testAudio);
        console.log('📄 Removed generated test-audio.mp3');
      }
    }
    
    console.log('\n✅ Cleanup completed!');
    
  } catch (error) {
    console.error('\n❌ Cleanup failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

cleanup();
