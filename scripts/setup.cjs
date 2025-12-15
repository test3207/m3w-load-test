#!/usr/bin/env node
/**
 * Setup script for M3W Load Test
 * 
 * Checks and installs all dependencies:
 * - Container runtime (docker/podman)
 * - k6 load testing tool
 * - Node.js dependencies
 * 
 * Usage:
 *   npm run setup
 *   node scripts/setup.cjs
 */

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

function log(msg) {
  console.log(msg);
}

function success(msg) {
  console.log(`✅ ${msg}`);
}

function warn(msg) {
  console.log(`⚠️  ${msg}`);
}

function error(msg) {
  console.log(`❌ ${msg}`);
}

function commandExists(cmd) {
  try {
    if (isWindows) {
      execSync(`where ${cmd}`, { stdio: 'ignore' });
    } else {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function getVersion(cmd) {
  try {
    return execSync(`${cmd} --version`, { encoding: 'utf-8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

function runCommand(cmd, description) {
  log(`\n📦 ${description}...`);
  log(`   $ ${cmd}`);
  
  try {
    execSync(cmd, { stdio: 'inherit', cwd: PROJECT_ROOT });
    return true;
  } catch (e) {
    error(`Failed: ${e.message}`);
    return false;
  }
}

async function checkContainerRuntime() {
  log('\n🐳 Checking container runtime...');
  
  const hasDocker = commandExists('docker');
  const hasPodman = commandExists('podman');
  
  if (hasDocker) {
    const version = getVersion('docker');
    success(`Docker found: ${version}`);
    
    // Check docker compose
    try {
      execSync('docker compose version', { stdio: 'ignore' });
      success('Docker Compose (plugin) available');
    } catch {
      warn('Docker Compose plugin not found, checking standalone...');
      if (commandExists('docker-compose')) {
        success('docker-compose (standalone) available');
      } else {
        warn('Docker Compose not found. Please install it.');
      }
    }
    return 'docker';
  }
  
  if (hasPodman) {
    const version = getVersion('podman');
    success(`Podman found: ${version}`);
    
    // Check podman-compose
    if (commandExists('podman-compose')) {
      const composeVersion = getVersion('podman-compose');
      success(`podman-compose found: ${composeVersion}`);
    } else {
      warn('podman-compose not found. Installing...');
      if (isWindows) {
        runCommand('pip install podman-compose', 'Installing podman-compose via pip');
      } else if (isMac) {
        runCommand('brew install podman-compose', 'Installing podman-compose via brew');
      } else {
        runCommand('pip3 install podman-compose', 'Installing podman-compose via pip3');
      }
    }
    return 'podman';
  }
  
  error('No container runtime found!');
  log('\nPlease install Docker or Podman:');
  if (isWindows) {
    log('  Docker Desktop: https://docs.docker.com/desktop/install/windows-install/');
    log('  Podman Desktop: https://podman-desktop.io/');
  } else if (isMac) {
    log('  brew install --cask docker');
    log('  brew install podman');
  } else {
    log('  sudo apt install docker.io docker-compose-v2');
    log('  sudo apt install podman podman-compose');
  }
  return null;
}

async function checkK6() {
  log('\n📊 Checking k6...');
  
  if (commandExists('k6')) {
    const version = getVersion('k6');
    success(`k6 found: ${version}`);
    return true;
  }
  
  warn('k6 not found. Installing...');
  
  let installed = false;
  
  if (isWindows) {
    // Try winget first
    if (commandExists('winget')) {
      installed = runCommand('winget install GrafanaLabs.k6 --accept-source-agreements --accept-package-agreements', 'Installing k6 via winget');
    }
    // Try chocolatey as fallback
    if (!installed && commandExists('choco')) {
      installed = runCommand('choco install k6 -y', 'Installing k6 via chocolatey');
    }
    if (!installed) {
      error('Could not install k6 automatically.');
      log('Please install manually:');
      log('  winget install GrafanaLabs.k6');
      log('  # or');
      log('  choco install k6');
      log('  # or download from: https://k6.io/docs/get-started/installation/');
    }
  } else if (isMac) {
    installed = runCommand('brew install k6', 'Installing k6 via brew');
  } else {
    // Linux - try different package managers
    if (commandExists('apt')) {
      runCommand('sudo gpg -k', 'Checking GPG');
      runCommand('sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69', 'Adding k6 GPG key');
      runCommand('echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list', 'Adding k6 repository');
      installed = runCommand('sudo apt update && sudo apt install k6 -y', 'Installing k6 via apt');
    } else if (commandExists('dnf')) {
      runCommand('sudo dnf install https://dl.k6.io/rpm/repo.rpm -y', 'Adding k6 repository');
      installed = runCommand('sudo dnf install k6 -y', 'Installing k6 via dnf');
    }
  }
  
  // Verify installation
  if (installed && commandExists('k6')) {
    const version = getVersion('k6');
    success(`k6 installed: ${version}`);
    return true;
  }
  
  return false;
}

async function checkNodeDeps() {
  log('\n📦 Checking Node.js dependencies...');
  
  const nodeModulesPath = path.join(PROJECT_ROOT, 'node_modules');
  
  if (!fs.existsSync(nodeModulesPath)) {
    log('   node_modules not found, running npm install...');
    runCommand('npm install', 'Installing dependencies');
  } else {
    success('node_modules exists');
  }
  
  // Verify key packages
  try {
    require.resolve('jsonwebtoken');
    require.resolve('pg');
    success('Required packages available (jsonwebtoken, pg)');
    return true;
  } catch {
    warn('Missing packages, running npm install...');
    runCommand('npm install', 'Installing dependencies');
    return true;
  }
}

async function setup() {
  console.log('🚀 M3W Load Test - Setup');
  console.log('========================');
  console.log(`Platform: ${os.platform()} ${os.arch()}`);
  console.log(`Node.js: ${process.version}`);
  
  const results = {
    container: false,
    k6: false,
    deps: false,
  };
  
  // Check container runtime
  results.container = !!(await checkContainerRuntime());
  
  // Check k6
  results.k6 = await checkK6();
  
  // Check Node.js dependencies
  results.deps = await checkNodeDeps();
  
  // Summary
  console.log('\n\n📋 Setup Summary');
  console.log('================');
  console.log(`Container runtime: ${results.container ? '✅' : '❌'}`);
  console.log(`k6 load testing:   ${results.k6 ? '✅' : '❌'}`);
  console.log(`Node.js deps:      ${results.deps ? '✅' : '❌'}`);
  
  if (results.container && results.k6 && results.deps) {
    console.log('\n✅ Setup complete! You can now run:');
    console.log('   npm run test:full    # Full test with k6');
    console.log('   npm run test:quick   # Quick test without k6');
    return 0;
  } else {
    console.log('\n⚠️  Some components are missing. Please install them manually.');
    return 1;
  }
}

setup().then(code => process.exit(code));
