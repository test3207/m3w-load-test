/**
 * Seed test data for load testing
 * 
 * Creates:
 * - Test user (or uses existing)
 * - Test library with sample songs
 * - Test playlists
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function seed() {
  console.log('🌱 Seeding test data...');
  console.log(`Target: ${BASE_URL}`);
  
  // TODO: Implement seeding logic
  // 1. Create test user or get auth token
  // 2. Create test library
  // 3. Upload sample audio files
  // 4. Create test playlists
  
  console.log('⚠️  Seed script not yet implemented');
  console.log('For now, manually prepare test data and set TEST_USER_TOKEN and TEST_SONG_ID');
  
  // Output example env vars
  console.log('\nExample environment variables:');
  console.log('  export BASE_URL=http://localhost:4000');
  console.log('  export TEST_USER_TOKEN=<your-jwt-token>');
  console.log('  export TEST_SONG_ID=<a-valid-song-id>');
}

seed().catch(console.error);
