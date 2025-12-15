/**
 * Run Upload Stress Test
 * 
 * Orchestrates the complete upload stress test workflow:
 * 1. Ensure test files exist (generate if needed)
 * 2. Load environment from .env.test
 * 3. Start resource monitoring
 * 4. Run k6 upload test
 * 5. Generate report
 * 
 * Options:
 *   --quick       Run with smaller file (5MB) and shorter duration
 *   --size N      Specify file size in MB (5, 20, 50, 100)
 *   --concurrent  Target concurrent uploads (default: 10)
 *   --skip-gen    Skip file generation (assume files exist)
 * 
 * Usage:
 *   npm run test:upload           # Full test with 50MB file
 *   npm run test:upload:quick     # Quick test with 5MB file
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env.test');
const FIXTURES_DIR = path.join(ROOT_DIR, 'fixtures');
const RESULTS_DIR = path.join(ROOT_DIR, 'results');

// File size mapping
const FILE_MAP = {
  5: { name: 'small-5mb.bin', bytes: 5 * 1024 * 1024 },
  20: { name: 'medium-20mb.bin', bytes: 20 * 1024 * 1024 },
  50: { name: 'large-50mb.bin', bytes: 50 * 1024 * 1024 },
  100: { name: 'xlarge-100mb.bin', bytes: 100 * 1024 * 1024 },
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    quick: args.includes('--quick'),
    skipGen: args.includes('--skip-gen'),
    size: 50, // Default 50MB
    concurrent: 10,
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--size' && args[i + 1]) {
      options.size = parseInt(args[i + 1]);
    }
    if (args[i] === '--concurrent' && args[i + 1]) {
      options.concurrent = parseInt(args[i + 1]);
    }
  }
  
  // Quick mode uses 5MB file
  if (options.quick) {
    options.size = 5;
  }
  
  return options;
}

// Load environment from .env.test
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error('.env.test not found! Run `npm run seed` first.');
  }
  
  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  const env = {};
  
  for (const line of content.split('\n')) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      env[match[1]] = match[2];
    }
  }
  
  return env;
}

// Ensure test file exists
function ensureTestFile(sizeMB, skipGen) {
  const fileInfo = FILE_MAP[sizeMB];
  if (!fileInfo) {
    throw new Error(`Invalid size: ${sizeMB}MB. Available: ${Object.keys(FILE_MAP).join(', ')}MB`);
  }
  
  const filePath = path.join(FIXTURES_DIR, fileInfo.name);
  
  if (fs.existsSync(filePath)) {
    console.log(`✅ Test file exists: ${fileInfo.name}`);
    return { path: filePath, bytes: fileInfo.bytes };
  }
  
  if (skipGen) {
    throw new Error(`Test file not found: ${fileInfo.name}. Remove --skip-gen to generate.`);
  }
  
  console.log(`📦 Generating test file: ${fileInfo.name}...`);
  execSync(`node scripts/generate-upload-files.cjs --size ${sizeMB}`, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  
  return { path: filePath, bytes: fileInfo.bytes };
}

// Start resource monitor in background
function startMonitor() {
  const monitorScript = path.join(__dirname, 'monitor.cjs');
  
  if (!fs.existsSync(monitorScript)) {
    console.log('⚠️  Monitor script not found, skipping resource monitoring');
    return null;
  }
  
  const monitor = spawn('node', [monitorScript], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  
  monitor.stdout.on('data', (data) => {
    // Just log to console, don't clutter output
    const line = data.toString().trim();
    if (line.includes('CPU') || line.includes('Memory')) {
      console.log(`📊 ${line}`);
    }
  });
  
  console.log(`📊 Resource monitor started (PID: ${monitor.pid})`);
  return monitor;
}

// Run k6 upload test
function runK6Test(testFile, env, options) {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = path.join(RESULTS_DIR, `upload-${timestamp}.json`);
    
    // Ensure results directory exists
    if (!fs.existsSync(RESULTS_DIR)) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }
    
    const k6Args = [
      'run',
      'k6/upload.js',
      '--env', `BASE_URL=${env.BASE_URL || 'http://localhost:4000'}`,
      '--env', `TEST_USER_TOKEN=${env.TEST_USER_TOKEN}`,
      '--env', `TEST_LIBRARY_ID=${env.TEST_LIBRARY_ID}`,
      '--env', `TEST_FILE_PATH=${path.relative(ROOT_DIR, testFile.path)}`,
      '--env', `FILE_SIZE_BYTES=${testFile.bytes}`,
      '--env', `CONCURRENT_UPLOADS=${options.concurrent}`,
      '--out', `json=${outputFile}`,
    ];
    
    // Quick mode: shorter duration
    if (options.quick) {
      k6Args.push('--duration', '1m');
      k6Args.push('--vus', '5');
    }
    
    console.log('\n🚀 Starting k6 upload test...');
    console.log(`   File: ${path.basename(testFile.path)} (${(testFile.bytes / 1024 / 1024).toFixed(0)}MB)`);
    console.log(`   Output: ${path.basename(outputFile)}`);
    console.log('');
    
    const k6 = spawn('k6', k6Args, {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      shell: true,
    });
    
    k6.on('close', (code) => {
      if (code === 0) {
        resolve(outputFile);
      } else {
        reject(new Error(`k6 exited with code ${code}`));
      }
    });
    
    k6.on('error', (err) => {
      reject(new Error(`Failed to start k6: ${err.message}`));
    });
  });
}

// Main function
async function main() {
  console.log('🔥 M3W Upload Stress Test');
  console.log('=========================\n');
  
  const options = parseArgs();
  console.log(`📋 Options:`);
  console.log(`   File size: ${options.size}MB`);
  console.log(`   Concurrent: ${options.concurrent}`);
  console.log(`   Quick mode: ${options.quick}`);
  console.log('');
  
  try {
    // Load environment
    const env = loadEnv();
    console.log(`✅ Environment loaded from .env.test`);
    console.log(`   Base URL: ${env.BASE_URL || 'http://localhost:4000'}`);
    console.log(`   Library: ${env.TEST_LIBRARY_ID}`);
    console.log('');
    
    // Ensure test file exists
    const testFile = ensureTestFile(options.size, options.skipGen);
    
    // Start monitor (optional)
    const monitor = startMonitor();
    
    // Run k6 test
    const outputFile = await runK6Test(testFile, env, options);
    
    // Stop monitor
    if (monitor) {
      monitor.kill();
      console.log('📊 Resource monitor stopped');
    }
    
    console.log('\n✅ Upload stress test completed');
    console.log(`📄 Results: ${outputFile}`);
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
