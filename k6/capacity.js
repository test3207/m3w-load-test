import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { config, thresholds, capacityStages, behavior, endpoints } from './config.js';

// Custom metrics
const errorRate = new Rate('errors');
const apiDuration = new Trend('api_duration', true);
const streamTTFB = new Trend('stream_ttfb', true);

export const options = {
  stages: capacityStages,
  thresholds: thresholds,
};

// Request headers with auth
function getHeaders() {
  return {
    'Authorization': `Bearer ${config.testUserToken}`,
    'Content-Type': 'application/json',
  };
}

// Startup phase: auth check, list libraries and playlists
function startupPhase() {
  const headers = getHeaders();
  
  // Get current user
  let res = http.get(`${config.baseUrl}${endpoints.me}`, { 
    headers,
    tags: { type: 'api' },
  });
  apiDuration.add(res.timings.duration);
  check(res, { 'auth check ok': (r) => r.status === 200 });
  
  // List libraries
  res = http.get(`${config.baseUrl}${endpoints.libraries}`, { 
    headers,
    tags: { type: 'api' },
  });
  apiDuration.add(res.timings.duration);
  check(res, { 'list libraries ok': (r) => r.status === 200 });
  
  // List playlists
  res = http.get(`${config.baseUrl}${endpoints.playlists}`, { 
    headers,
    tags: { type: 'api' },
  });
  apiDuration.add(res.timings.duration);
  check(res, { 'list playlists ok': (r) => r.status === 200 });
  
  sleep(1);
}

// Listening phase: stream audio, update progress
function listeningPhase(songId) {
  const headers = getHeaders();
  
  // Stream audio (with range request simulation)
  const streamRes = http.get(`${config.baseUrl}${endpoints.stream(songId)}`, {
    headers: {
      ...headers,
      'Range': 'bytes=0-',
    },
    tags: { type: 'stream' },
  });
  streamTTFB.add(streamRes.timings.waiting);
  
  const streamOk = check(streamRes, { 
    'stream ok': (r) => r.status === 200 || r.status === 206,
  });
  errorRate.add(!streamOk);
  
  // Simulate listening for 30 seconds, update progress
  sleep(30);
  
  // Update progress (PUT method)
  const progressRes = http.put(
    `${config.baseUrl}${endpoints.progress}`,
    JSON.stringify({
      songId: songId,
      position: Math.floor(Math.random() * 180), // Random position 0-180s
    }),
    { headers, tags: { type: 'api' } }
  );
  apiDuration.add(progressRes.timings.duration);
  check(progressRes, { 'progress update ok': (r) => r.status === 200 });
}

// Managing phase: create/delete playlist
function managingPhase() {
  const headers = getHeaders();
  
  // Create playlist
  const createRes = http.post(
    `${config.baseUrl}${endpoints.playlists}`,
    JSON.stringify({
      name: `Load Test Playlist ${Date.now()}`,
    }),
    { headers, tags: { type: 'api' } }
  );
  apiDuration.add(createRes.timings.duration);
  check(createRes, { 'create playlist ok': (r) => r.status === 200 || r.status === 201 });
  
  if (createRes.status === 200 || createRes.status === 201) {
    const playlist = createRes.json();
    sleep(2);
    
    // Delete playlist
    const deleteRes = http.del(
      `${config.baseUrl}${endpoints.playlists}/${playlist.data?.id || playlist.id}`,
      null,
      { headers, tags: { type: 'api' } }
    );
    apiDuration.add(deleteRes.timings.duration);
    check(deleteRes, { 'delete playlist ok': (r) => r.status === 200 || r.status === 204 });
  }
  
  sleep(1);
}

// Main test function
export default function() {
  // Determine which phase to execute based on weights
  const rand = Math.random();
  
  if (rand < behavior.startup) {
    // Startup phase (5%)
    startupPhase();
  } else if (rand < behavior.startup + behavior.listening) {
    // Listening phase (85%)
    const testSongId = config.testSongId;
    if (!testSongId) {
      console.warn('TEST_SONG_ID not set, skipping listening phase');
      sleep(1);
      return;
    }
    listeningPhase(testSongId);
  } else {
    // Managing phase (10%)
    managingPhase();
  }
}

// Setup function - runs once before test
export function setup() {
  console.log(`Starting capacity test against ${config.baseUrl}`);
  console.log(`Stages: ${JSON.stringify(capacityStages)}`);
  
  // Verify connectivity
  const res = http.get(`${config.baseUrl}/health`);
  if (res.status !== 200) {
    throw new Error(`Health check failed: ${res.status}`);
  }
  
  return { startTime: Date.now() };
}

// Teardown function - runs once after test
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Test completed in ${duration}s`);
}
