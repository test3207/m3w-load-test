/**
 * Cleanup test data after load testing
 * 
 * Removes:
 * - Test playlists created during load test (prefix: "Load Test Playlist")
 * - Optionally: test library and all its songs (--full flag)
 * - Optionally: test user from database (--full flag)
 * 
 * Usage:
 *   npm run cleanup          # Remove test playlists only
 *   npm run cleanup:full     # Remove everything including library and user
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/m3w';
const JWT_SECRET = process.env.JWT_SECRET || 'load-test-secret-key';
const FULL_CLEANUP = process.argv.includes('--full');

// Same test user as seed.cjs
const TEST_USER = {
  id: 'load-test-user-001',
  email: 'loadtest@m3w.local',
};

// Try to read token from .env.test first, otherwise generate
let TOKEN = process.env.TEST_USER_TOKEN;

function generateAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      type: 'access',
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function loadEnvFile() {
  const envFile = path.join(__dirname, '..', '.env.test');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const [key, value] = line.split('=');
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
    return true;
  }
  return false;
}

async function apiRequest(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  const response = await fetch(url, {
    ...options,
    headers,
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${text}`);
  }
  
  return response.json();
}

async function deletePlaylist(id) {
  await apiRequest(`/api/playlists/${id}`, { method: 'DELETE' });
  console.log(`  🗑️  Deleted playlist: ${id}`);
}

async function deleteLibrary(id) {
  await apiRequest(`/api/libraries/${id}`, { method: 'DELETE' });
  console.log(`  🗑️  Deleted library: ${id}`);
}

async function deleteTestUserFromDB() {
  console.log('\n👤 Removing test user from database...');
  
  const client = new Client({ connectionString: DATABASE_URL });
  
  try {
    await client.connect();
    
    const result = await client.query(
      'DELETE FROM users WHERE id = $1 OR email = $2 RETURNING id',
      [TEST_USER.id, TEST_USER.email]
    );
    
    if (result.rowCount > 0) {
      console.log(`  ✅ Deleted test user: ${TEST_USER.email}`);
    } else {
      console.log('  No test user found');
    }
  } finally {
    await client.end();
  }
}

async function cleanup() {
  console.log('🧹 M3W Load Test - Cleanup Script');
  console.log('==================================');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Mode: ${FULL_CLEANUP ? 'Full cleanup (playlists + library + user)' : 'Playlists only'}`);
  console.log('');
  
  // Load .env.test if exists
  loadEnvFile();
  
  // Get token from env or generate
  TOKEN = process.env.TEST_USER_TOKEN || generateAccessToken(TEST_USER);
  
  if (!TOKEN) {
    console.error('❌ Error: Could not get or generate auth token');
    process.exit(1);
  }
  
  try {
    // Step 1: Delete load test playlists
    console.log('📋 Cleaning up playlists...');
    const playlists = (await apiRequest('/api/playlists')).data || [];
    const loadTestPlaylists = playlists.filter(p => 
      p.name.startsWith('Load Test Playlist')
    );
    
    if (loadTestPlaylists.length === 0) {
      console.log('  No load test playlists found');
    } else {
      for (const playlist of loadTestPlaylists) {
        await deletePlaylist(playlist.id);
      }
      console.log(`  ✅ Deleted ${loadTestPlaylists.length} playlists`);
    }
    
    // Step 2: Full cleanup - delete test library
    if (FULL_CLEANUP) {
      console.log('\n📚 Cleaning up test library...');
      const libraries = (await apiRequest('/api/libraries')).data || [];
      const testLibrary = libraries.find(lib => lib.name === 'Load Test Library');
      
      if (testLibrary) {
        if (testLibrary.canDelete === false) {
          console.log('  ⚠️  Test library cannot be deleted (is default library)');
        } else {
          await deleteLibrary(testLibrary.id);
          console.log('  ✅ Deleted test library');
        }
      } else {
        console.log('  No test library found');
      }
      
      // Also delete test user from database
      await deleteTestUserFromDB();
      
      // Clean up .env.test file
      const envFile = path.join(__dirname, '..', '.env.test');
      if (fs.existsSync(envFile)) {
        fs.unlinkSync(envFile);
        console.log('\n📄 Removed .env.test file');
      }
    }
    
    console.log('\n✅ Cleanup completed!');
    
  } catch (error) {
    console.error('\n❌ Cleanup failed:', error.message);
    process.exit(1);
  }
}

cleanup();
