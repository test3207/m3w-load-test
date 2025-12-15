#!/usr/bin/env node
/**
 * Complete load test runner
 * 
 * Runs the full test cycle:
 * 1. Start container environment (docker/podman)
 * 2. Wait for services to be ready
 * 3. Seed test data
 * 4. Run k6 load test
 * 5. Cleanup test data
 * 6. Stop and remove containers
 * 
 * Usage:
 *   npm run test:full                    # Run with default settings
 *   npm run test:full -- --keep          # Keep containers running after test
 *   npm run test:full -- --podman        # Force use podman
 *   npm run test:full -- --docker        # Force use docker
 *   npm run test:full -- --skip-k6       # Skip k6 test (just verify setup)
 */

const { spawn, execSync } = require('child_process');
const path = require('path');

// Configuration
const PROJECT_ROOT = path.join(__dirname, '..');
const KEEP_CONTAINERS = process.argv.includes('--keep');
const SKIP_K6 = process.argv.includes('--skip-k6');
const FORCE_PODMAN = process.argv.includes('--podman');
const FORCE_DOCKER = process.argv.includes('--docker');

// Detect container runtime
function detectRuntime() {
  if (FORCE_PODMAN) return 'podman';
  if (FORCE_DOCKER) return 'docker';
  
  // Auto-detect: prefer docker, fallback to podman
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return 'docker';
  } catch {
    try {
      execSync('podman --version', { stdio: 'ignore' });
      return 'podman';
    } catch {
      return null;
    }
  }
}

function getComposeCommand(runtime) {
  if (runtime === 'podman') {
    // Check for podman-compose
    try {
      execSync('podman-compose --version', { stdio: 'ignore' });
      return 'podman-compose';
    } catch {
      // Podman 3.0+ has built-in compose
      return 'podman compose';
    }
  }
  return 'docker compose';
}

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    
    const proc = spawn(command, args, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: true,
      ...options,
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    
    proc.on('error', reject);
  });
}

function runSync(command) {
  try {
    return execSync(command, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

async function waitForHealth(url, maxAttempts = 60, interval = 2000) {
  console.log(`\n⏳ Waiting for ${url} to be healthy...`);
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log(`✅ Service is healthy!`);
        return true;
      }
    } catch {
      // Service not ready yet
    }
    
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, interval));
  }
  
  throw new Error(`Service did not become healthy within ${maxAttempts * interval / 1000}s`);
}

async function main() {
  console.log('🚀 M3W Load Test - Full Test Runner');
  console.log('====================================');
  
  // Step 0: Detect runtime
  const runtime = detectRuntime();
  if (!runtime) {
    console.error('❌ Neither docker nor podman found. Please install one of them.');
    process.exit(1);
  }
  
  const compose = getComposeCommand(runtime);
  console.log(`\n📦 Using: ${runtime} (${compose})`);
  console.log(`   Keep containers: ${KEEP_CONTAINERS}`);
  console.log(`   Skip k6 test: ${SKIP_K6}`);
  
  let exitCode = 0;
  
  try {
    // Step 1: Start containers
    console.log('\n\n📦 Step 1: Starting containers...');
    await run(compose, ['up', '-d']);
    
    // Step 2: Wait for M3W to be healthy
    console.log('\n\n⏳ Step 2: Waiting for services...');
    await waitForHealth('http://localhost:4000/health');
    
    // Give it a couple more seconds for database migrations
    console.log('   Waiting for database migrations...');
    await new Promise(r => setTimeout(r, 5000));
    
    // Step 3: Seed test data
    console.log('\n\n🌱 Step 3: Seeding test data...');
    await run('node', ['scripts/seed.cjs']);
    
    // Step 4: Run k6 test
    if (!SKIP_K6) {
      console.log('\n\n🔥 Step 4: Running k6 load test...');
      
      // Check if k6 is installed
      const k6Version = runSync('k6 version');
      if (!k6Version) {
        console.error('❌ k6 not found. Please install k6: https://k6.io/docs/get-started/installation/');
        console.log('   Skipping k6 test...');
      } else {
        console.log(`   k6 version: ${k6Version}`);
        
        // Source .env.test and run k6
        // On Windows we need to handle this differently
        const isWindows = process.platform === 'win32';
        if (isWindows) {
          // Read .env.test and set env vars
          const fs = require('fs');
          const envFile = path.join(PROJECT_ROOT, '.env.test');
          if (fs.existsSync(envFile)) {
            const envContent = fs.readFileSync(envFile, 'utf-8');
            for (const line of envContent.split('\n')) {
              const [key, ...valueParts] = line.split('=');
              if (key && valueParts.length > 0) {
                process.env[key.trim()] = valueParts.join('=').trim();
              }
            }
          }
          await run('k6', ['run', 'k6/capacity.js']);
        } else {
          await run('bash', ['-c', 'source .env.test && k6 run k6/capacity.js']);
        }
      }
    } else {
      console.log('\n\n⏭️  Step 4: Skipping k6 test (--skip-k6 flag)');
    }
    
    // Step 5: Cleanup test data
    console.log('\n\n🧹 Step 5: Cleaning up test data...');
    await run('node', ['scripts/cleanup.cjs', '--full']);
    
    console.log('\n\n✅ Test completed successfully!');
    
  } catch (error) {
    console.error('\n\n❌ Test failed:', error.message);
    exitCode = 1;
  } finally {
    // Step 6: Stop containers (unless --keep flag)
    if (!KEEP_CONTAINERS) {
      console.log('\n\n📦 Step 6: Stopping containers...');
      try {
        await run(compose, ['down', '-v']);
        console.log('✅ Containers stopped and removed');
      } catch (e) {
        console.error('⚠️  Failed to stop containers:', e.message);
      }
    } else {
      console.log('\n\n📦 Step 6: Keeping containers running (--keep flag)');
      console.log('   To stop manually: npm run docker:down');
    }
  }
  
  process.exit(exitCode);
}

main();
