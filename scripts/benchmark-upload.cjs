/**
 * Upload Benchmark Script
 * 
 * Runs multiple upload tests with different file sizes and concurrency levels
 * to measure CPU/memory scaling characteristics.
 * 
 * Test matrix:
 * - File sizes: 5MB, 20MB, 50MB
 * - Concurrency: 5, 10, 20 VUs
 * 
 * Usage:
 *   node scripts/benchmark-upload.cjs
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// Test matrix
const FILE_SIZES = [5, 20, 50]; // MB
const CONCURRENCY_LEVELS = [5, 10, 20]; // VUs

// Shorter test duration for benchmark (2 min per test)
const TEST_DURATION = '2m';

// Results storage
const results = [];

// Detect container runtime
function detectRuntime() {
  try {
    execSync('podman --version', { stdio: 'ignore' });
    return { runtime: 'podman', compose: 'podman-compose' };
  } catch {
    try {
      execSync('docker --version', { stdio: 'ignore' });
      return { runtime: 'docker', compose: 'docker-compose' };
    } catch {
      throw new Error('Neither podman nor docker found');
    }
  }
}

const { runtime, compose } = detectRuntime();

function run(cmd, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: true,
    });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
    proc.on('error', reject);
  });
}

function runSync(cmd) {
  return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
}

async function waitForHealth(url, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write('.');
  }
  throw new Error('Health check timeout');
}

async function startContainers() {
  console.log('\n📦 Starting containers...');
  await run(compose, ['up', '-d']);
  console.log('\n⏳ Waiting for services...');
  await waitForHealth('http://localhost:4000/health');
  console.log('\n✅ Services ready');
  await new Promise(r => setTimeout(r, 10000)); // Wait for migrations
}

async function stopContainers() {
  console.log('\n📦 Stopping containers...');
  await run(compose, ['down', '-v']);
}

async function seedData() {
  console.log('\n🌱 Seeding test data...');
  await run('node', ['scripts/seed.cjs']);
}

async function clearDatabase() {
  console.log('\n🧹 Clearing songs and files...');
  const { Client } = require('pg');
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/m3w';
  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
    // Only delete songs and files, keep user and library
    await client.query('DELETE FROM songs');
    await client.query('DELETE FROM files');
    await client.query('UPDATE libraries SET "songCount" = 0');
    console.log('   ✅ Cleared');
  } finally {
    await client.end();
  }
}

async function generateTestFile(sizeMB) {
  console.log(`\n📦 Generating ${sizeMB}MB test file...`);
  const seed = Date.now().toString();
  await run('node', ['scripts/generate-upload-files.cjs', '--size', String(sizeMB), `--seed=${seed}`]);
}

function findK6() {
  const locations = [
    'k6',
    'C:\\Program Files\\k6\\k6.exe',
    '/usr/local/bin/k6',
    '/usr/bin/k6',
  ];
  for (const loc of locations) {
    try {
      execSync(`"${loc}" version`, { stdio: 'ignore' });
      return loc;
    } catch {}
  }
  return null;
}

async function runUploadTest(sizeMB, maxVUs) {
  console.log(`\n🔥 Testing: ${sizeMB}MB file, ${maxVUs} VUs`);
  
  const k6 = findK6();
  if (!k6) throw new Error('k6 not found');
  
  // Read env file for auth
  const envFile = path.join(PROJECT_ROOT, '.env.test');
  if (!fs.existsSync(envFile)) {
    throw new Error('.env.test not found - run seed first');
  }
  const envContent = fs.readFileSync(envFile, 'utf-8');
  const env = {};
  for (const line of envContent.split('\n')) {
    const [key, ...valueParts] = line.split('=');
    if (key) env[key.trim()] = valueParts.join('=').trim();
  }
  
  const fileSizeBytes = sizeMB * 1024 * 1024;
  const fileBase = sizeMB === 5 ? 'small-5mb' : sizeMB === 20 ? 'medium-20mb' : 'large-50mb';
  
  // Create custom k6 config for this test
  const k6ConfigPath = path.join(PROJECT_ROOT, 'k6', 'benchmark-config.js');
  const k6Config = `
export const benchmarkStages = [
  { duration: '30s', target: ${maxVUs} },  // Ramp up
  { duration: '${TEST_DURATION}', target: ${maxVUs} },  // Steady state
  { duration: '30s', target: 0 },  // Ramp down
];
export const maxVUs = ${maxVUs};
`;
  fs.writeFileSync(k6ConfigPath, k6Config);
  
  // Monitor resources during test
  const samples = [];
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
        const [name, cpu, mem] = line.split('\t');
        const shortName = name.replace('m3w-load-test-', '').replace('m3w-load-test', 'm3w');
        const cpuVal = parseFloat(cpu) || 0;
        const memMatch = mem.match(/([\d.]+)([GMK]i?B)/);
        let memMB = 0;
        if (memMatch) {
          const val = parseFloat(memMatch[1]);
          const unit = memMatch[2];
          if (unit.startsWith('G')) memMB = val * 1024;
          else if (unit.startsWith('M')) memMB = val;
          else if (unit.startsWith('K')) memMB = val / 1024;
        }
        containers[shortName] = { cpu: cpuVal, mem: memMB };
      }
      
      samples.push({ timestamp, containers });
    } catch {}
  }, 2000);
  
  // Run k6 with auth env vars
  const k6Args = [
    'run', 'k6/upload.js',
    '--env', `TEST_FILE_BASE=fixtures/${fileBase}`,
    '--env', `FILE_SIZE_BYTES=${fileSizeBytes}`,
    '--env', 'VARIANTS_COUNT=1',
    '--env', `BENCHMARK_MODE=true`,
    '--env', `MAX_VUS=${maxVUs}`,
    '--env', `BASE_URL=${env.BASE_URL || 'http://localhost:4000'}`,
    '--env', `TEST_USER_TOKEN=${env.TEST_USER_TOKEN}`,
    '--env', `TEST_LIBRARY_ID=${env.TEST_LIBRARY_ID}`,
  ];
  
  let testSuccess = true;
  try {
    await run(`"${k6}"`, k6Args);
  } catch (e) {
    console.warn('   ⚠️ k6 exited with error');
    testSuccess = false;
  }
  
  clearInterval(monitorInterval);
  
  // Analyze results
  const m3wSamples = samples.map(s => s.containers.m3w).filter(Boolean);
  const analysis = {
    sizeMB,
    maxVUs,
    testSuccess,
    samples: samples.length,
    m3w: {
      cpuAvg: m3wSamples.length ? (m3wSamples.reduce((a, b) => a + b.cpu, 0) / m3wSamples.length).toFixed(1) : 0,
      cpuMax: m3wSamples.length ? Math.max(...m3wSamples.map(s => s.cpu)).toFixed(1) : 0,
      memAvg: m3wSamples.length ? Math.round(m3wSamples.reduce((a, b) => a + b.mem, 0) / m3wSamples.length) : 0,
      memMax: m3wSamples.length ? Math.round(Math.max(...m3wSamples.map(s => s.mem))) : 0,
      memMin: m3wSamples.length ? Math.round(Math.min(...m3wSamples.map(s => s.mem))) : 0,
    },
  };
  
  results.push(analysis);
  
  console.log(`   CPU: avg=${analysis.m3w.cpuAvg}% max=${analysis.m3w.cpuMax}%`);
  console.log(`   Mem: avg=${analysis.m3w.memAvg}MB max=${analysis.m3w.memMax}MB`);
  
  // Clean database for next test
  await clearDatabase();
  
  return analysis;
}

async function printResults() {
  console.log('\n\n' + '='.repeat(80));
  console.log('📊 BENCHMARK RESULTS');
  console.log('='.repeat(80));
  
  // Table header
  console.log('\n┌──────────┬───────┬────────────────────┬────────────────────┐');
  console.log('│ File Size│  VUs  │   CPU (avg/max)    │   Mem (avg/max)    │');
  console.log('├──────────┼───────┼────────────────────┼────────────────────┤');
  
  for (const r of results) {
    const status = r.testSuccess ? '✓' : '✗';
    console.log(
      `│ ${String(r.sizeMB).padStart(5)}MB │ ${String(r.maxVUs).padStart(5)} │ ` +
      `${r.m3w.cpuAvg.toString().padStart(5)}% / ${r.m3w.cpuMax.toString().padStart(5)}% │ ` +
      `${String(r.m3w.memAvg).padStart(5)}MB / ${String(r.m3w.memMax).padStart(5)}MB │ ${status}`
    );
  }
  
  console.log('└──────────┴───────┴────────────────────┴────────────────────┘');
  
  // Analysis: scaling characteristics
  console.log('\n📈 SCALING ANALYSIS:');
  
  // Group by file size
  for (const size of FILE_SIZES) {
    const sizeResults = results.filter(r => r.sizeMB === size);
    if (sizeResults.length < 2) continue;
    
    // Calculate memory slope per VU
    const sorted = sizeResults.sort((a, b) => a.maxVUs - b.maxVUs);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const vuDiff = last.maxVUs - first.maxVUs;
    const memDiff = last.m3w.memMax - first.m3w.memMax;
    const cpuDiff = parseFloat(last.m3w.cpuMax) - parseFloat(first.m3w.cpuMax);
    
    console.log(`\n   ${size}MB files:`);
    console.log(`   Memory slope: ${(memDiff / vuDiff).toFixed(1)}MB per VU`);
    console.log(`   CPU slope: ${(cpuDiff / vuDiff).toFixed(2)}% per VU`);
  }
  
  // Group by concurrency
  for (const vus of CONCURRENCY_LEVELS) {
    const vuResults = results.filter(r => r.maxVUs === vus);
    if (vuResults.length < 2) continue;
    
    const sorted = vuResults.sort((a, b) => a.sizeMB - b.sizeMB);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const sizeDiff = last.sizeMB - first.sizeMB;
    const memDiff = last.m3w.memMax - first.m3w.memMax;
    
    console.log(`\n   ${vus} VUs:`);
    console.log(`   Memory slope: ${(memDiff / sizeDiff).toFixed(1)}MB per MB file size`);
  }
  
  // Save results
  const resultsFile = path.join(PROJECT_ROOT, 'results', `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
  fs.writeFileSync(resultsFile, JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\n📄 Results saved to: ${resultsFile}`);
}

async function main() {
  console.log('🔬 M3W Upload Benchmark');
  console.log('========================');
  console.log(`File sizes: ${FILE_SIZES.join(', ')}MB`);
  console.log(`Concurrency: ${CONCURRENCY_LEVELS.join(', ')} VUs`);
  console.log(`Total tests: ${FILE_SIZES.length * CONCURRENCY_LEVELS.length}`);
  console.log('');
  
  try {
    await startContainers();
    await seedData();
    
    // Run all combinations
    for (const sizeMB of FILE_SIZES) {
      await generateTestFile(sizeMB);
      
      for (const vus of CONCURRENCY_LEVELS) {
        await runUploadTest(sizeMB, vus);
        
        // Brief pause between tests
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    
    await printResults();
    
  } finally {
    await stopContainers();
  }
}

main().catch(err => {
  console.error('❌ Benchmark failed:', err);
  process.exit(1);
});
