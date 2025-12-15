/**
 * Seed test data for load testing
 * 
 * Creates:
 * - Test library with sample songs
 * - Test playlists
 * 
 * Prerequisites:
 * - M3W instance running at BASE_URL
 * - Valid TEST_USER_TOKEN (JWT from authenticated user)
 * - Sample audio files in ./fixtures/ directory
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const TOKEN = process.env.TEST_USER_TOKEN;

// Output file for test configuration
const OUTPUT_FILE = path.join(__dirname, '..', '.env.test');

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

async function checkHealth() {
  console.log('🔍 Checking service health...');
  const response = await fetch(`${BASE_URL}/health`);
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }
  console.log('✅ Service is healthy');
}

async function checkAuth() {
  console.log('🔐 Checking authentication...');
  const result = await apiRequest('/api/auth/me');
  if (!result.success) {
    throw new Error('Authentication failed');
  }
  console.log(`✅ Authenticated as: ${result.data.name || result.data.username}`);
  return result.data;
}

async function getOrCreateTestLibrary() {
  console.log('📚 Checking for test library...');
  
  // List existing libraries
  const listResult = await apiRequest('/api/libraries');
  const libraries = listResult.data || [];
  
  // Look for existing load test library
  let library = libraries.find(lib => lib.name === 'Load Test Library');
  
  if (library) {
    console.log(`✅ Found existing test library: ${library.id}`);
  } else {
    // Create new library
    console.log('📝 Creating test library...');
    const createResult = await apiRequest('/api/libraries', {
      method: 'POST',
      body: JSON.stringify({ name: 'Load Test Library' }),
    });
    library = createResult.data;
    console.log(`✅ Created test library: ${library.id}`);
  }
  
  return library;
}

async function getSongsInLibrary(libraryId) {
  const result = await apiRequest(`/api/libraries/${libraryId}/songs`);
  return result.data || [];
}

async function uploadTestAudio(libraryId, filePath) {
  const fileName = path.basename(filePath);
  console.log(`📤 Uploading: ${fileName}`);
  
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = '----FormBoundary' + Date.now();
  
  // Build multipart form data manually
  const parts = [];
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`);
  parts.push('Content-Type: audio/mpeg\r\n\r\n');
  
  const header = Buffer.from(parts.join(''));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fileBuffer, footer]);
  
  const response = await fetch(`${BASE_URL}/api/libraries/${libraryId}/songs`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  
  if (!response.ok) {
    const text = await response.text();
    console.warn(`⚠️  Upload failed for ${fileName}: ${text}`);
    return null;
  }
  
  const result = await response.json();
  console.log(`✅ Uploaded: ${fileName} -> ${result.data?.id}`);
  return result.data;
}

async function createTestPlaylist(name, songIds = []) {
  console.log(`📝 Creating playlist: ${name}`);
  
  const result = await apiRequest('/api/playlists', {
    method: 'POST',
    body: JSON.stringify({ name, songIds }),
  });
  
  console.log(`✅ Created playlist: ${result.data?.id}`);
  return result.data;
}

async function writeEnvFile(config) {
  const content = Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  
  fs.writeFileSync(OUTPUT_FILE, content + '\n');
  console.log(`\n📄 Configuration written to ${OUTPUT_FILE}`);
}

async function seed() {
  console.log('🌱 M3W Load Test - Seed Script');
  console.log('================================');
  console.log(`Target: ${BASE_URL}`);
  console.log('');
  
  // Validate token
  if (!TOKEN) {
    console.error('❌ Error: TEST_USER_TOKEN environment variable is required');
    console.log('\nTo get a token:');
    console.log('1. Log in to M3W in your browser');
    console.log('2. Open DevTools > Application > Cookies');
    console.log('3. Copy the value of "access_token" cookie');
    console.log('4. Set: export TEST_USER_TOKEN=<token>');
    process.exit(1);
  }
  
  try {
    // Step 1: Health check
    await checkHealth();
    
    // Step 2: Verify auth
    await checkAuth();
    
    // Step 3: Get or create test library
    const library = await getOrCreateTestLibrary();
    
    // Step 4: Check for existing songs
    let songs = await getSongsInLibrary(library.id);
    console.log(`📊 Library has ${songs.length} songs`);
    
    // Step 5: Upload test audio files if fixtures exist
    const fixturesDir = path.join(__dirname, '..', 'fixtures');
    if (fs.existsSync(fixturesDir)) {
      const audioFiles = fs.readdirSync(fixturesDir)
        .filter(f => f.endsWith('.mp3') || f.endsWith('.flac') || f.endsWith('.m4a'));
      
      if (audioFiles.length > 0) {
        console.log(`\n📁 Found ${audioFiles.length} audio files in fixtures/`);
        for (const file of audioFiles) {
          const filePath = path.join(fixturesDir, file);
          await uploadTestAudio(library.id, filePath);
        }
        // Refresh song list
        songs = await getSongsInLibrary(library.id);
      }
    } else {
      console.log('\n💡 Tip: Add audio files to fixtures/ directory for automatic upload');
    }
    
    // Step 6: Create test playlist if we have songs
    if (songs.length > 0) {
      const existingPlaylists = (await apiRequest('/api/playlists')).data || [];
      const testPlaylist = existingPlaylists.find(p => p.name === 'Load Test Playlist');
      
      if (!testPlaylist) {
        const songIds = songs.slice(0, 10).map(s => s.id); // First 10 songs
        await createTestPlaylist('Load Test Playlist', songIds);
      } else {
        console.log(`✅ Test playlist already exists: ${testPlaylist.id}`);
      }
    }
    
    // Step 7: Write env file for k6
    const testSongId = songs.length > 0 ? songs[0].id : '';
    const envConfig = {
      BASE_URL,
      TEST_USER_TOKEN: TOKEN,
      TEST_LIBRARY_ID: library.id,
      TEST_SONG_ID: testSongId,
    };
    
    await writeEnvFile(envConfig);
    
    // Summary
    console.log('\n✅ Seed completed!');
    console.log('================================');
    console.log(`Library ID: ${library.id}`);
    console.log(`Songs: ${songs.length}`);
    console.log(`Test Song ID: ${testSongId || '(none - upload audio files)'}`);
    console.log('\nTo run load test:');
    console.log('  source .env.test');
    console.log('  k6 run k6/capacity.js');
    
  } catch (error) {
    console.error('\n❌ Seed failed:', error.message);
    process.exit(1);
  }
}

seed();
