/**
 * Cleanup test data after load testing
 * 
 * Removes:
 * - Test playlists created during load test (prefix: "Load Test Playlist")
 * - Optionally: test library and all its songs (--full flag)
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const TOKEN = process.env.TEST_USER_TOKEN;
const FULL_CLEANUP = process.argv.includes('--full');

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

async function cleanup() {
  console.log('🧹 M3W Load Test - Cleanup Script');
  console.log('==================================');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Mode: ${FULL_CLEANUP ? 'Full cleanup' : 'Playlists only'}`);
  console.log('');
  
  if (!TOKEN) {
    console.error('❌ Error: TEST_USER_TOKEN environment variable is required');
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
    }
    
    console.log('\n✅ Cleanup completed!');
    
  } catch (error) {
    console.error('\n❌ Cleanup failed:', error.message);
    process.exit(1);
  }
}

cleanup();
