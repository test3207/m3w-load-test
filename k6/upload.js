import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { config, thresholds, endpoints } from './config.js';

/**
 * Upload Stress Test
 * 
 * Purpose: Validate memory stability of stream-based upload implementation
 * Tests: Large files (50-100MB), concurrent uploads, memory recovery
 * 
 * Related Issue: test3207/m3w#121
 * Background: PRs #120, #128 implemented streaming upload to MinIO
 * 
 * Usage:
 *   # First generate test files
 *   node scripts/generate-upload-files.cjs
 * 
 *   # Run upload stress test (requires TEST_FILE_PATH env)
 *   k6 run k6/upload.js --env TEST_FILE_PATH=fixtures/large-100mb.bin
 */

// Custom metrics
const uploadErrorRate = new Rate('upload_errors');
const uploadDuration = new Trend('upload_duration', true);
const uploadThroughput = new Trend('upload_throughput_mbps', true);
const uploadCount = new Counter('upload_count');

// Configuration from environment
const uploadConfig = {
  // Test file base name (without variant number)
  testFileBase: __ENV.TEST_FILE_BASE || 'fixtures/small-5mb',
  // File size in bytes (for throughput calculation)
  fileSizeBytes: parseInt(__ENV.FILE_SIZE_BYTES || '5242880'), // 5MB default
  // Number of file variants (to avoid deduplication)
  variantsCount: parseInt(__ENV.VARIANTS_COUNT || '10'),
};

// Upload test stages - designed for memory stress testing
const defaultStages = [
  { duration: '30s', target: 1 },   // Single upload warm-up
  { duration: '1m', target: 5 },    // Low concurrency
  { duration: '2m', target: 10 },   // Medium concurrency
  { duration: '2m', target: 20 },   // High concurrency
  { duration: '1m', target: 0 },    // Cool-down (memory recovery check)
];

// Benchmark mode: shorter tests with configurable VUs
const benchmarkMode = __ENV.BENCHMARK_MODE === 'true';
const maxVUs = parseInt(__ENV.MAX_VUS || '20');
const benchmarkStages = [
  { duration: '30s', target: maxVUs },  // Ramp up
  { duration: '2m', target: maxVUs },   // Steady state
  { duration: '30s', target: 0 },       // Ramp down
];

export const uploadStages = benchmarkMode ? benchmarkStages : defaultStages;

// Upload-specific thresholds
export const uploadThresholds = {
  // Upload should complete (generous timeout for large files)
  'http_req_duration{type:upload}': ['p(95)<120000'], // 2 min
  // Error rate
  'upload_errors': ['rate<0.05'], // Allow 5% for stress test
  // Throughput should be reasonable (> 1 Mbps)
  'upload_throughput_mbps': ['avg>1'],
};

export const options = {
  stages: uploadStages,
  thresholds: uploadThresholds,
  // Don't abort on failed thresholds during stress test
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)'],
};

// Load only ONE base file - modify bytes at runtime to create unique hashes
// This keeps memory usage minimal (~5MB) regardless of iteration count
const baseFilePath = `../${uploadConfig.testFileBase}-0.bin`;
const baseFileData = open(baseFilePath, 'b');

// Request headers with auth
function getHeaders() {
  return {
    'Authorization': `Bearer ${config.testUserToken}`,
  };
}

/**
 * Create unique file data by modifying bytes in the base file
 * Modifies bytes after ID3 header to change hash while keeping valid MP3 structure
 */
function createUniqueFileData(vu, iter) {
  // Convert ArrayBuffer to Uint8Array for modification
  const data = new Uint8Array(baseFileData);
  const uniqueData = new Uint8Array(data.length);
  uniqueData.set(data);
  
  // Modify bytes at offset 100-116 (after ID3 header, in audio data)
  // This changes the file hash while keeping MP3 structure valid
  const timestamp = Date.now();
  const offset = 100;
  
  // Write VU number (4 bytes)
  uniqueData[offset] = (vu >> 24) & 0xFF;
  uniqueData[offset + 1] = (vu >> 16) & 0xFF;
  uniqueData[offset + 2] = (vu >> 8) & 0xFF;
  uniqueData[offset + 3] = vu & 0xFF;
  
  // Write iteration number (4 bytes)
  uniqueData[offset + 4] = (iter >> 24) & 0xFF;
  uniqueData[offset + 5] = (iter >> 16) & 0xFF;
  uniqueData[offset + 6] = (iter >> 8) & 0xFF;
  uniqueData[offset + 7] = iter & 0xFF;
  
  // Write timestamp (8 bytes for more uniqueness)
  uniqueData[offset + 8] = (timestamp >> 56) & 0xFF;
  uniqueData[offset + 9] = (timestamp >> 48) & 0xFF;
  uniqueData[offset + 10] = (timestamp >> 40) & 0xFF;
  uniqueData[offset + 11] = (timestamp >> 32) & 0xFF;
  uniqueData[offset + 12] = (timestamp >> 24) & 0xFF;
  uniqueData[offset + 13] = (timestamp >> 16) & 0xFF;
  uniqueData[offset + 14] = (timestamp >> 8) & 0xFF;
  uniqueData[offset + 15] = timestamp & 0xFF;
  
  return uniqueData.buffer;
}

/**
 * Generate multipart form data for file upload
 */
function createUploadBody(fileData, filename) {
  return {
    file: http.file(fileData, filename, 'audio/mpeg'),
  };
}

/**
 * Main upload test function
 */
export default function() {
  const headers = getHeaders();
  const libraryId = config.testLibraryId;
  
  if (!libraryId) {
    console.error('TEST_LIBRARY_ID not set! Run seed first.');
    return;
  }
  
  // Create unique file content for each request by modifying base file bytes
  // This ensures each upload has a different hash without loading multiple files
  const uniqueFileData = createUniqueFileData(__VU, __ITER);
  
  // Generate unique filename for each upload (for logging only, server uses content hash)
  const filename = `upload-${__VU}-${__ITER}-${Date.now()}.mp3`;
  
  // Upload file
  const startTime = Date.now();
  const uploadUrl = `${config.baseUrl}${endpoints.songs(libraryId)}`;
  
  const response = http.post(
    uploadUrl,
    createUploadBody(uniqueFileData, filename),
    {
      headers,
      tags: { type: 'upload' },
      timeout: '180s', // 3 min timeout for large files
    }
  );
  
  const duration = Date.now() - startTime;
  const throughputMbps = (uploadConfig.fileSizeBytes / 1024 / 1024) / (duration / 1000);
  
  // Record metrics
  uploadDuration.add(duration);
  uploadThroughput.add(throughputMbps);
  uploadCount.add(1);
  
  // Check response
  let songId = null;
  const uploadOk = check(response, {
    'upload status ok': (r) => r.status === 200 || r.status === 201,
    'upload has song id': (r) => {
      try {
        const body = JSON.parse(r.body);
        // Response: { success: true, data: { song: { id: ... } } }
        if (body.success && body.data && body.data.song && body.data.song.id) {
          songId = body.data.song.id;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
  });
  
  uploadErrorRate.add(!uploadOk);
    // Delete the song immediately after successful upload
  // This allows the same file to be uploaded again for higher concurrency tests
  if (songId) {
    const deleteRes = http.del(
      `${config.baseUrl}/api/songs/${songId}?libraryId=${libraryId}`,
      null,
      { headers, tags: { type: 'delete' } }
    );
    if (deleteRes.status !== 200 && deleteRes.status !== 204) {
      console.log(`Delete failed: ${deleteRes.status} - ${deleteRes.body}`);
    }
  }
  if (!uploadOk) {
    console.log(`Upload failed: ${response.status} - ${response.body}`);
  }
  
  // Small delay between uploads to simulate realistic usage
  sleep(Math.random() * 2 + 1); // 1-3 seconds
}

/**
 * Setup: Verify environment and log configuration
 */
export function setup() {
  console.log('=== Upload Stress Test Configuration ===');
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Library ID: ${config.testLibraryId}`);
  console.log(`Test file: ${uploadConfig.testFilePath}`);
  console.log(`File size: ${(uploadConfig.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Stages: ${uploadStages.length}`);
  console.log('========================================');
  
  // Verify auth
  const authRes = http.get(`${config.baseUrl}/api/auth/me`, {
    headers: getHeaders(),
  });
  
  if (authRes.status !== 200) {
    throw new Error(`Auth failed: ${authRes.status}. Check TEST_USER_TOKEN.`);
  }
  
  // Verify library access
  const libRes = http.get(`${config.baseUrl}/api/libraries/${config.testLibraryId}`, {
    headers: getHeaders(),
  });
  
  if (libRes.status !== 200) {
    throw new Error(`Library access failed: ${libRes.status}. Check TEST_LIBRARY_ID.`);
  }
  
  return { startTime: Date.now() };
}

/**
 * Teardown: Log final results
 */
export function teardown(data) {
  const totalTime = (Date.now() - data.startTime) / 1000;
  console.log('=== Upload Stress Test Complete ===');
  console.log(`Total duration: ${totalTime.toFixed(0)} seconds`);
  console.log('===================================');
}
