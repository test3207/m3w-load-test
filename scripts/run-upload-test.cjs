#!/usr/bin/env node
/**
 * Upload stress test runner
 * 
 * Runs the full upload stress test cycle:
 * 1. Start container environment (docker/podman)
 * 2. Wait for services to be ready
 * 3. Seed test data
 * 4. Generate test files (if needed)
 * 5. Run k6 upload stress test
 * 6. Cleanup test data
 * 7. Stop and remove containers
 * 
 * Usage:
 *   npm run test:upload                    # Run with default (5MB file)
 *   npm run test:upload -- --size 50       # Use 50MB file (5/20/50/100)
 *   npm run test:upload -- --keep          # Keep containers running after test
 *   npm run test:upload -- --podman        # Force use podman
 *   npm run test:upload -- --docker        # Force use docker
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const PROJECT_ROOT = path.join(__dirname, '..');
const KEEP_CONTAINERS = process.argv.includes('--keep');
const FORCE_PODMAN = process.argv.includes('--podman');
const FORCE_DOCKER = process.argv.includes('--docker');

// Parse --size argument
function getUploadSize() {
  const idx = process.argv.indexOf('--size');
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1]);
  }
  return 5; // Default 5MB
}

const FILE_MAP = {
  5: { base: 'small-5mb', bytes: 5 * 1024 * 1024 },
  20: { base: 'medium-20mb', bytes: 20 * 1024 * 1024 },
  50: { base: 'large-50mb', bytes: 50 * 1024 * 1024 },
  100: { base: 'xlarge-100mb', bytes: 100 * 1024 * 1024 },
};

const VARIANTS_COUNT = 1;

// Detect container runtime
function detectRuntime() {
  if (FORCE_PODMAN) return 'podman';
  if (FORCE_DOCKER) return 'docker';
  
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
    try {
      execSync('podman-compose --version', { stdio: 'ignore' });
      return 'podman-compose';
    } catch {
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

function findK6() {
  const k6Version = runSync('k6 version');
  if (k6Version) return 'k6';
  
  if (process.platform === 'win32') {
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
  const uploadSize = getUploadSize();
  const fileInfo = FILE_MAP[uploadSize] || FILE_MAP[5];
  
  console.log('🔥 M3W Upload Stress Test');
  console.log('=========================');
  
  // Step 0: Detect runtime
  const runtime = detectRuntime();
  if (!runtime) {
    console.error('❌ Neither docker nor podman found. Please install one of them.');
    process.exit(1);
  }
  
  const compose = getComposeCommand(runtime);
  console.log(`\n📦 Using: ${runtime} (${compose})`);
  console.log(`   Keep containers: ${KEEP_CONTAINERS}`);
  console.log(`   File size: ${uploadSize}MB (${fileInfo.base}-*.bin x ${VARIANTS_COUNT})`);
  
  let exitCode = 0;
  
  try {
    // Step 1: Start containers
    console.log('\n\n📦 Step 1: Starting containers...');
    await run(compose, ['up', '-d']);
    
    // Step 2: Wait for M3W to be healthy
    console.log('\n\n⏳ Step 2: Waiting for services...');
    await waitForHealth('http://localhost:4000/health');
    console.log('   Waiting for database migrations...');
    await new Promise(r => setTimeout(r, 15000));
    
    // Step 3: Seed test data
    console.log('\n\n🌱 Step 3: Seeding test data...');
    await run('node', ['scripts/seed.cjs']);
    
    // Step 3.5: Clear songs and files from database (to avoid deduplication conflicts)
    console.log('\n\n🧹 Step 3.5: Clearing songs and files from database...');
    const { Client } = require('pg');
    const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/m3w';
    const dbClient = new Client({ connectionString: dbUrl });
    try {
      await dbClient.connect();
      
      // Delete all songs first (foreign key to files)
      const songsResult = await dbClient.query('DELETE FROM songs RETURNING id');
      console.log(`   Deleted ${songsResult.rowCount} songs`);
      
      // Delete all files
      const filesResult = await dbClient.query('DELETE FROM files RETURNING id');
      console.log(`   Deleted ${filesResult.rowCount} files`);
      
      // Reset library song counts
      await dbClient.query('UPDATE libraries SET "songCount" = 0');
      console.log('   ✅ Database cleared');
    } catch (err) {
      console.warn(`   ⚠️ Database clear failed: ${err.message}`);
    } finally {
      await dbClient.end();
    }
    
    // Step 4: Generate test files (always regenerate with fresh seed to avoid deduplication)
    console.log('\n\n📦 Step 4: Generating test files with unique content...');
    const testSeed = Date.now().toString();
    console.log(`   Using seed: ${testSeed}`);
    console.log(`   Generating ${uploadSize}MB test files (x${VARIANTS_COUNT})...`);
    await run('node', ['scripts/generate-upload-files.cjs', '--size', String(uploadSize), `--seed=${testSeed}`]);
    
    // Step 5: Run k6 upload stress test
    console.log('\n\n🔥 Step 5: Running upload stress test...');
    
    const k6Cmd = findK6();
    if (!k6Cmd) {
      console.error('❌ k6 not found. Please run: npm run setup');
      throw new Error('k6 not found');
    }
    
    const k6Version = runSync(`${k6Cmd} version`);
    console.log(`   k6 version: ${k6Version}`);
    
    // Start resource monitor
    console.log('   Starting resource monitor...');
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
    
    // Run k6 upload test
    await run(k6Cmd, [
      'run', 'k6/upload.js',
      '--env', `TEST_FILE_BASE=fixtures/${fileInfo.base}`,
      '--env', `FILE_SIZE_BYTES=${fileInfo.bytes}`,
      '--env', `VARIANTS_COUNT=${VARIANTS_COUNT}`,
    ]);
    
    // Stop monitor and calculate results
    clearInterval(monitorInterval);
    
    console.log('\n\n📊 Resource usage summary:');
    if (monitorSamples.length === 0) {
      console.log('   (no samples collected)');
    } else {
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
      
      // Memory analysis for upload test
      if (stats['m3w']) {
        const memSamples = stats['m3w'].memSamples;
        const memBaseline = memSamples[0];
        const memMax = Math.max(...memSamples);
        const memFinal = memSamples[memSamples.length - 1];
        const memLimit = 2048; // 2GB limit
        
        console.log('\n💡 Memory analysis (M3W container):');
        console.log(`   Baseline: ${memBaseline.toFixed(0)}MB`);
        console.log(`   Peak: ${memMax.toFixed(0)}MB (+${(memMax - memBaseline).toFixed(0)}MB)`);
        console.log(`   Final: ${memFinal.toFixed(0)}MB`);
        
        const memRecovered = memFinal < memBaseline * 1.2;
        console.log(`   Recovery: ${memRecovered ? '✅ OK' : '⚠️ Memory not fully released'}`);
        
        if (memMax > memLimit * 0.8) {
          console.log(`   ⚠️ Peak memory > 80% of limit (${memLimit}MB)`);
        }
      }
      
      // Save raw data
      const resultsDir = path.join(PROJECT_ROOT, 'results');
      if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(
        path.join(resultsDir, `upload-${timestamp}.json`),
        JSON.stringify({ uploadSize, samples: monitorSamples, stats }, null, 2)
      );
      console.log(`\n   Raw data saved to: results/upload-${timestamp}.json`);
    }
    
    // Step 6: Cleanup test data
    console.log('\n\n🧹 Step 6: Cleaning up test data...');
    await run('node', ['scripts/cleanup.cjs', '--full']);
    
    console.log('\n\n✅ Upload stress test completed!');
    
  } catch (error) {
    console.error('\n\n❌ Test failed:', error.message);
    exitCode = 1;
  } finally {
    // Step 7: Stop containers (unless --keep flag)
    if (!KEEP_CONTAINERS) {
      console.log('\n\n📦 Step 7: Stopping containers...');
      try {
        await run(compose, ['down', '-v']);
        console.log('✅ Containers stopped and removed');
      } catch (e) {
        console.error('⚠️  Failed to stop containers:', e.message);
      }
    } else {
      console.log('\n\n📦 Step 7: Keeping containers running (--keep flag)');
      console.log('   To stop manually: npm run docker:down');
    }
  }
  
  process.exit(exitCode);
}

main();
