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
  // Test file path (relative to project root)
  testFilePath: __ENV.TEST_FILE_PATH || 'fixtures/test-audio.mp3',
  // File size in bytes (for throughput calculation)
  fileSizeBytes: parseInt(__ENV.FILE_SIZE_BYTES || '3145728'), // 3MB default
  // Concurrent uploads target
  concurrentUploads: parseInt(__ENV.CONCURRENT_UPLOADS || '10'),
};

// Upload test stages - designed for memory stress testing
export const uploadStages = [
  { duration: '30s', target: 1 },   // Single upload warm-up
  { duration: '1m', target: 5 },    // Low concurrency
  { duration: '2m', target: 10 },   // Medium concurrency
  { duration: '2m', target: 20 },   // High concurrency
  { duration: '1m', target: 0 },    // Cool-down (memory recovery check)
];

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

// Load test file as binary data
// Note: k6 loads file once and shares across VUs
const testFileData = open(__ENV.TEST_FILE_PATH || '../fixtures/test-audio.mp3', 'b');

// Request headers with auth
function getHeaders() {
  return {
    'Authorization': `Bearer ${config.testUserToken}`,
  };
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
  
  // Generate unique filename for each upload
  const filename = `upload-test-${__VU}-${__ITER}-${Date.now()}.mp3`;
  
  // Upload file
  const startTime = Date.now();
  const uploadUrl = `${config.baseUrl}${endpoints.songs(libraryId)}`;
  
  const response = http.post(
    uploadUrl,
    createUploadBody(testFileData, filename),
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
  const uploadOk = check(response, {
    'upload status ok': (r) => r.status === 200 || r.status === 201,
    'upload has song id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data && body.data.id;
      } catch {
        return false;
      }
    },
  });
  
  uploadErrorRate.add(!uploadOk);
  
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
