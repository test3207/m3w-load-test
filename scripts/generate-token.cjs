/**
 * Generate JWT token for load testing
 * 
 * Uses the same JWT_SECRET as the test environment to create valid tokens
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'load-test-secret-key';

// Create a test user payload
const testUser = {
  id: process.env.TEST_USER_ID || `load-test-user-${Date.now()}`,
  email: process.env.TEST_USER_EMAIL || 'loadtest@example.com',
  name: 'Load Test User',
};

function generateAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      type: 'access',
    },
    JWT_SECRET,
    { expiresIn: '24h' } // Long expiry for load testing
  );
}

function generateRefreshToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      type: 'refresh',
    },
    JWT_SECRET,
    { expiresIn: '90d' }
  );
}

// Generate tokens
const accessToken = generateAccessToken(testUser);
const refreshToken = generateRefreshToken(testUser);

console.log('🔑 Generated JWT tokens for load testing');
console.log('=========================================');
console.log(`User ID: ${testUser.id}`);
console.log(`Email: ${testUser.email}`);
console.log(`JWT Secret: ${JWT_SECRET}`);
console.log('');
console.log('Access Token (24h):');
console.log(accessToken);
console.log('');
console.log('Refresh Token (90d):');
console.log(refreshToken);
console.log('');
console.log('Export command:');
console.log(`export TEST_USER_TOKEN="${accessToken}"`);
