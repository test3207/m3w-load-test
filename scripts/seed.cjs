/**
 * Seed test data for load testing
 * 
 * FULLY AUTOMATIC - No manual steps required!
 * 
 * This script will:
 * 1. Connect to PostgreSQL directly and create test user
 * 2. Generate a valid JWT token
 * 3. Create test library with sample songs
 * 4. Create test playlists
 * 
 * Environment variables:
 * - BASE_URL: M3W API URL (default: http://localhost:4000)
 * - DATABASE_URL: PostgreSQL connection string (default: from docker-compose)
 * - JWT_SECRET: JWT secret (default: load-test-secret-key)
 * 
 * Usage:
 *   npm run seed
 *   # or
 *   node scripts/seed.cjs
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/m3w';
const JWT_SECRET = process.env.JWT_SECRET || 'load-test-secret-key';

// Output file for test configuration
const OUTPUT_FILE = path.join(__dirname, '..', '.env.test');

// Test user - stable ID so we don't create duplicates
const TEST_USER = {
  id: 'load-test-user-001',
  email: 'loadtest@m3w.local',
  name: 'Load Test User',
};

// Token will be generated
let TOKEN = null;

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

/**
 * Create test user directly in PostgreSQL database
 */
async function createTestUserInDB() {
  console.log('🗄️  Connecting to database...');
  
  const client = new Client({ connectionString: DATABASE_URL });
  
  try {
    await client.connect();
    console.log('✅ Database connected');
    
    // Check if user exists
    const checkResult = await client.query(
      'SELECT id, email, name FROM users WHERE id = $1 OR email = $2',
      [TEST_USER.id, TEST_USER.email]
    );
    
    if (checkResult.rows.length > 0) {
      const existingUser = checkResult.rows[0];
      console.log(`✅ Test user already exists: ${existingUser.email}`);
      TEST_USER.id = existingUser.id;
      return existingUser;
    }
    
    // Create user
    console.log('👤 Creating test user in database...');
    const now = new Date().toISOString();
    
    await client.query(
      `INSERT INTO users (id, email, name, "createdAt", "updatedAt", "cacheAllEnabled") 
       VALUES ($1, $2, $3, $4, $4, false)`,
      [TEST_USER.id, TEST_USER.email, TEST_USER.name, now]
    );
    
    console.log(`✅ Test user created: ${TEST_USER.email}`);
    return TEST_USER;
    
  } finally {
    await client.end();
  }
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

async function checkHealth() {
  console.log('🔍 Checking service health...');
  const response = await fetch(`${BASE_URL}/health`);
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }
  console.log('✅ Service is healthy');
}

async function verifyAuth() {
  console.log('🔐 Verifying authentication...');
  const result = await apiRequest('/api/auth/me');
  if (result.success) {
    console.log(`✅ Authenticated as: ${result.data.name || result.data.email}`);
    return result.data;
  }
  throw new Error('Authentication failed');
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

/**
 * Generate a test audio file using ffmpeg (if available)
 * Creates a 5-second silent MP3 for testing
 */
function generateTestAudio() {
  const testAudioPath = path.join(__dirname, '..', 'fixtures', 'test-audio.mp3');
  
  // Check if already exists
  if (fs.existsSync(testAudioPath)) {
    return testAudioPath;
  }
  
  console.log('🎵 Generating test audio file...');
  
  // Generate a minimal valid MP3 file with white noise
  // This creates a proper MP3 that M3W can process
  const mp3Data = generateMinimalMp3();
  fs.writeFileSync(testAudioPath, mp3Data);
  console.log('✅ Generated test audio: test-audio.mp3 (5 sec white noise)');
  return testAudioPath;
}

/**
 * Generate a minimal valid MP3 file with white noise
 * Creates ~5 seconds of audio at 128kbps
 */
function generateMinimalMp3() {
  // MP3 frame header for 128kbps, 44100Hz, stereo
  // MPEG Audio Layer 3, 128kbps, 44100Hz, stereo, no padding
  const frameHeader = Buffer.from([0xFF, 0xFB, 0x90, 0x00]);
  
  // Each MP3 frame at 128kbps/44100Hz is 417 bytes (418 with padding)
  // Frame duration = 1152 samples / 44100Hz = 26.12ms
  // For 5 seconds: 5000ms / 26.12ms ≈ 191 frames
  const frameDataSize = 417 - 4; // minus header
  const numFrames = 191;
  
  // ID3v2 header with basic metadata
  const id3Header = createId3Tag({
    title: 'Load Test Track',
    artist: 'M3W Load Test',
    album: 'Test Album',
  });
  
  const frames = [];
  frames.push(id3Header);
  
  for (let i = 0; i < numFrames; i++) {
    // Create frame with white noise data
    const frameData = Buffer.alloc(frameDataSize);
    for (let j = 0; j < frameDataSize; j++) {
      // Generate pseudo-random noise that sounds like white noise when decoded
      frameData[j] = Math.floor(Math.random() * 256);
    }
    frames.push(Buffer.concat([frameHeader, frameData]));
  }
  
  return Buffer.concat(frames);
}

/**
 * Create a minimal ID3v2.3 tag
 */
function createId3Tag(metadata) {
  const frames = [];
  
  // TIT2 - Title
  if (metadata.title) {
    frames.push(createId3Frame('TIT2', metadata.title));
  }
  // TPE1 - Artist
  if (metadata.artist) {
    frames.push(createId3Frame('TPE1', metadata.artist));
  }
  // TALB - Album
  if (metadata.album) {
    frames.push(createId3Frame('TALB', metadata.album));
  }
  
  const framesBuffer = Buffer.concat(frames);
  const size = framesBuffer.length;
  
  // ID3v2.3 header
  const header = Buffer.from([
    0x49, 0x44, 0x33, // "ID3"
    0x03, 0x00,       // Version 2.3
    0x00,             // Flags
    // Size (syncsafe integer)
    (size >> 21) & 0x7F,
    (size >> 14) & 0x7F,
    (size >> 7) & 0x7F,
    size & 0x7F,
  ]);
  
  return Buffer.concat([header, framesBuffer]);
}

function createId3Frame(frameId, text) {
  const textBuffer = Buffer.from(text, 'utf8');
  const size = textBuffer.length + 1; // +1 for encoding byte
  
  return Buffer.concat([
    Buffer.from(frameId, 'ascii'),
    Buffer.from([
      (size >> 24) & 0xFF,
      (size >> 16) & 0xFF,
      (size >> 8) & 0xFF,
      size & 0xFF,
      0x00, 0x00, // Flags
      0x00,       // Encoding: ISO-8859-1
    ]),
    textBuffer,
  ]);
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
  console.log(`Target API: ${BASE_URL}`);
  console.log(`Database:   ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`JWT Secret: ${JWT_SECRET.substring(0, 10)}...`);
  console.log('');
  
  try {
    // Step 1: Create test user directly in database
    await createTestUserInDB();
    
    // Step 2: Generate JWT token
    TOKEN = generateAccessToken(TEST_USER);
    console.log(`🔑 JWT token generated for: ${TEST_USER.email}`);
    
    // Step 3: Health check
    await checkHealth();
    
    // Step 4: Verify auth works
    await verifyAuth();
    
    // Step 5: Get or create test library
    const library = await getOrCreateTestLibrary();
    
    // Step 6: Check for existing songs
    let songs = await getSongsInLibrary(library.id);
    console.log(`📊 Library has ${songs.length} songs`);
    
    // Step 7: Upload test audio files if fixtures exist
    const fixturesDir = path.join(__dirname, '..', 'fixtures');
    
    // First, try to generate test audio if none exists
    const audioFiles = fs.readdirSync(fixturesDir)
      .filter(f => /\.(mp3|flac|m4a|ogg|wav)$/i.test(f));
    
    if (audioFiles.length === 0) {
      // No audio files, try to generate one
      const generatedPath = generateTestAudio();
      if (generatedPath) {
        audioFiles.push(path.basename(generatedPath));
      }
    }
    
    if (audioFiles.length > 0) {
      console.log(`\n📁 Found ${audioFiles.length} audio files in fixtures/`);
      for (const file of audioFiles) {
        const filePath = path.join(fixturesDir, file);
        await uploadTestAudio(library.id, filePath);
      }
      songs = await getSongsInLibrary(library.id);
    } else {
      console.log('\n💡 Tip: Install ffmpeg or add audio files to fixtures/ directory');
    }
    
    // Step 8: Create test playlist if we have songs
    if (songs.length > 0) {
      const existingPlaylists = (await apiRequest('/api/playlists')).data || [];
      const testPlaylist = existingPlaylists.find(p => p.name === 'Load Test Playlist');
      
      if (!testPlaylist) {
        const songIds = songs.slice(0, 10).map(s => s.id);
        await createTestPlaylist('Load Test Playlist', songIds);
      } else {
        console.log(`✅ Test playlist already exists: ${testPlaylist.id}`);
      }
    }
    
    // Step 9: Write env file for k6
    const testSongId = songs.length > 0 ? songs[0].id : '';
    const envConfig = {
      BASE_URL,
      TEST_USER_TOKEN: TOKEN,
      TEST_LIBRARY_ID: library.id,
      TEST_SONG_ID: testSongId,
    };
    
    await writeEnvFile(envConfig);
    
    // Summary
    console.log('\n✅ Seed completed successfully!');
    console.log('================================');
    console.log(`Test User:   ${TEST_USER.email}`);
    console.log(`Library ID:  ${library.id}`);
    console.log(`Songs:       ${songs.length}`);
    console.log(`Test Song:   ${testSongId || '(none - add audio files to fixtures/)'}`);
    console.log('\n🚀 Ready to run load test:');
    console.log('   npm run test:capacity');
    console.log('   # or');
    console.log('   source .env.test && k6 run k6/capacity.js');
    
  } catch (error) {
    console.error('\n❌ Seed failed:', error.message);
    if (error.message.includes('ECONNREFUSED')) {
      console.error('\n💡 Make sure the M3W services are running:');
      console.error('   npm run docker:up');
    }
    process.exit(1);
  }
}

seed();
