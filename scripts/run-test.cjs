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

// Find k6 executable (handles Windows PATH not being updated after install)
function findK6() {
  // Try PATH first
  const k6Version = runSync('k6 version');
  if (k6Version) return 'k6';
  
  // On Windows, check common install locations
  if (process.platform === 'win32') {
    const fs = require('fs');
    const commonPaths = [
      'C:\\Program Files\\k6\\k6.exe',
      'C:\\Program Files (x86)\\k6\\k6.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'k6', 'k6.exe'),
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return `"${p}"`;
      }
    }
  }
  
  return null;
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
    
    // TODO: Switch to /ready endpoint once M3W image with #179 is released
    // await waitForHealth('http://localhost:4000/ready', 60, 3000);
    console.log('   Waiting for database migrations...');
    await new Promise(r => setTimeout(r, 15000));
    
    // Step 3: Seed test data
    console.log('\n\n🌱 Step 3: Seeding test data...');
    await run('node', ['scripts/seed.cjs']);
    
    // Step 4: Run k6 test
    if (!SKIP_K6) {
      console.log('\n\n🔥 Step 4: Running k6 load test...');
      
      // Find k6 executable
      const k6Cmd = findK6();
      if (!k6Cmd) {
        console.error('❌ k6 not found. Please run: npm run setup');
        console.log('   Skipping k6 test...');
      } else {
        const k6Version = runSync(`${k6Cmd} version`);
        console.log(`   k6 version: ${k6Version}`);
        
        // Start resource monitor inline (no subprocess)
        console.log('   Starting resource monitor...');
        const fs = require('fs');
        const monitorSamples = [];
        const monitorStart = Date.now();
        
        const monitorInterval = setInterval(() => {
          try {
            const output = execSync(
              `${runtime} stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"`,
              { encoding: 'utf-8', timeout: 5000 }
            );
            
            const timestamp = Date.now() - monitorStart;
            const containers = {};
            
            for (const line of output.trim().split('\n')) {
              if (!line.includes('m3w-load-test')) continue;
              
              const parts = line.split('\t');
              if (parts.length < 3) continue;
              
              const name = parts[0].replace('m3w-load-test-', '').replace('m3w-load-test', 'm3w');
              const cpuMatch = parts[1].match(/([\d.]+)/);
              const cpu = cpuMatch ? parseFloat(cpuMatch[1]) : 0;
              
              const memMatch = parts[2].match(/([\d.]+)(\w+)/);
              let memMB = 0;
              if (memMatch) {
                const val = parseFloat(memMatch[1]);
                const unit = memMatch[2].toLowerCase();
                if (unit.includes('gib') || unit.includes('gb')) memMB = val * 1024;
                else if (unit.includes('mib') || unit.includes('mb')) memMB = val;
                else if (unit.includes('kib') || unit.includes('kb')) memMB = val / 1024;
                else memMB = val;
              }
              
              containers[name] = { cpu, memMB };
            }
            
            if (Object.keys(containers).length > 0) {
              monitorSamples.push({ timestamp, containers });
            }
          } catch (e) {
            // Container might not be ready or stopping
          }
        }, 2000);
        
        // Load .env.test into process.env
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
        
        await run(k6Cmd, ['run', 'k6/capacity.js']);
        
        // Stop monitor and calculate results
        clearInterval(monitorInterval);
        
        console.log('\n\n📊 Resource usage summary:');
        if (monitorSamples.length === 0) {
          console.log('   (no samples collected)');
        } else {
          // Calculate statistics
          const stats = {};
          for (const sample of monitorSamples) {
            for (const [name, data] of Object.entries(sample.containers)) {
              if (!stats[name]) {
                stats[name] = { cpuSamples: [], memSamples: [] };
              }
              stats[name].cpuSamples.push(data.cpu);
              stats[name].memSamples.push(data.memMB);
            }
          }
          
          const duration = monitorSamples[monitorSamples.length - 1].timestamp;
          console.log(`   Duration: ${(duration / 1000).toFixed(1)}s | Samples: ${monitorSamples.length}`);
          
          for (const [name, data] of Object.entries(stats)) {
            const cpuAvg = data.cpuSamples.reduce((a, b) => a + b, 0) / data.cpuSamples.length;
            const cpuMax = Math.max(...data.cpuSamples);
            const memAvg = data.memSamples.reduce((a, b) => a + b, 0) / data.memSamples.length;
            const memMax = Math.max(...data.memSamples);
            
            console.log(`   ${name}: CPU avg=${cpuAvg.toFixed(1)}% max=${cpuMax.toFixed(1)}% | Mem avg=${memAvg.toFixed(0)}MB max=${memMax.toFixed(0)}MB`);
          }
          
          // Capacity estimate
          if (stats['m3w']) {
            const cpuMax = Math.max(...stats['m3w'].cpuSamples);
            const memMax = Math.max(...stats['m3w'].memSamples);
            const memLimit = 2048; // 2GB limit
            
            console.log('\n💡 Capacity estimate (M3W container):');
            console.log(`   At 500 VUs: CPU max ${cpuMax.toFixed(1)}%, Memory max ${memMax.toFixed(0)}MB`);
            if (cpuMax > 0) {
              console.log(`   Theoretical max VUs (CPU): ~${Math.floor(500 * (100 / cpuMax))}`);
            }
            if (memMax > 0) {
              console.log(`   Theoretical max VUs (Memory): ~${Math.floor(500 * (memLimit / memMax))}`);
            }
          }
          
          // Save raw data
          const resultsDir = path.join(PROJECT_ROOT, 'results');
          if (!fs.existsSync(resultsDir)) {
            fs.mkdirSync(resultsDir, { recursive: true });
          }
          fs.writeFileSync(
            path.join(resultsDir, 'resource-usage.json'),
            JSON.stringify({ samples: monitorSamples, stats }, null, 2)
          );
          console.log(`\n   Raw data saved to: results/resource-usage.json`);
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
