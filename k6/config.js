/**
 * Shared configuration for k6 load tests
 */

// Environment configuration
export const config = {
  baseUrl: __ENV.BASE_URL || 'http://localhost:4000',
  testUserToken: __ENV.TEST_USER_TOKEN || '',
  testLibraryId: __ENV.TEST_LIBRARY_ID || '',
  testSongId: __ENV.TEST_SONG_ID || '',
};

// Thresholds for success criteria
export const thresholds = {
  // API response time
  'http_req_duration{type:api}': ['p(95)<500'],
  // Audio stream TTFB
  'http_req_waiting{type:stream}': ['p(95)<200'],
  // Error rate
  'http_req_failed': ['rate<0.01'],
};

// Load stages for capacity test
export const capacityStages = [
  { duration: '1m', target: 1 },    // Warm-up
  { duration: '3m', target: 10 },   // Baseline
  { duration: '3m', target: 25 },   // Load
  { duration: '3m', target: 50 },   // Stress
  { duration: '3m', target: 100 },  // Peak
  { duration: '2m', target: 0 },    // Cool-down
];

// User behavior weights
export const behavior = {
  startup: 0.05,    // 5% - auth, list libraries/playlists
  listening: 0.85,  // 85% - stream audio, update progress
  managing: 0.10,   // 10% - create/delete playlists
};

// API endpoints
export const endpoints = {
  // Auth
  me: '/api/auth/me',
  
  // Libraries
  libraries: '/api/libraries',
  
  // Playlists
  playlists: '/api/playlists',
  
  // Songs
  songs: (libraryId) => `/api/libraries/${libraryId}/songs`,
  stream: (songId) => `/api/songs/${songId}/stream`,
  
  // Progress
  progress: '/api/progress',
};
