#!/usr/bin/env node
/**
 * Resource monitor for load testing
 * Records CPU/Memory usage of containers during test
 * 
 * Usage:
 *   node scripts/monitor.cjs              # Start monitoring
 *   node scripts/monitor.cjs --stop       # Stop and show summary
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, '..', 'results', 'resource-usage.json');
const PID_FILE = path.join(__dirname, '..', '.monitor.pid');

// Detect container runtime
function detectRuntime() {
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

function parseStats(line, runtime) {
  // Docker/Podman stats format: NAME CPU% MEM USAGE / LIMIT MEM% NET I/O BLOCK I/O
  // Example: m3w-load-test 45.23% 256MiB / 2GiB 12.50% ...
  
  const parts = line.trim().split(/\s{2,}/);
  if (parts.length < 4) return null;
  
  const name = parts[0];
  const cpuStr = parts[1];
  const memStr = parts[2];
  
  // Parse CPU percentage
  const cpuMatch = cpuStr.match(/([\d.]+)%/);
  const cpu = cpuMatch ? parseFloat(cpuMatch[1]) : 0;
  
  // Parse memory (e.g., "256MiB / 2GiB")
  const memMatch = memStr.match(/([\d.]+)(\w+)\s*\/\s*([\d.]+)(\w+)/);
  let memUsedMB = 0;
  let memLimitMB = 0;
  
  if (memMatch) {
    memUsedMB = parseMemory(parseFloat(memMatch[1]), memMatch[2]);
    memLimitMB = parseMemory(parseFloat(memMatch[3]), memMatch[4]);
  }
  
  return { name, cpu, memUsedMB, memLimitMB };
}

function parseMemory(value, unit) {
  const unitLower = unit.toLowerCase();
  if (unitLower.includes('gib') || unitLower.includes('gb')) {
    return value * 1024;
  }
  if (unitLower.includes('mib') || unitLower.includes('mb')) {
    return value;
  }
  if (unitLower.includes('kib') || unitLower.includes('kb')) {
    return value / 1024;
  }
  return value;
}

async function monitor() {
  const runtime = detectRuntime();
  if (!runtime) {
    console.error('❌ No container runtime found');
    process.exit(1);
  }
  
  console.log(`📊 Resource Monitor (${runtime})`);
  console.log('================================');
  console.log('Press Ctrl+C to stop\n');
  
  // Create results directory
  const resultsDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  
  const samples = [];
  const startTime = Date.now();
  
  // Sample every 2 seconds
  const interval = setInterval(() => {
    try {
      const output = execSync(
        `${runtime} stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      
      const timestamp = Date.now() - startTime;
      const containers = {};
      
      for (const line of output.trim().split('\n')) {
        if (!line.includes('m3w-load-test')) continue;
        
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        
        const name = parts[0].replace('m3w-load-test-', '').replace('m3w-load-test', 'm3w');
        const cpuMatch = parts[1].match(/([\d.]+)/);
        const cpu = cpuMatch ? parseFloat(cpuMatch[1]) : 0;
        
        // Parse memory
        const memMatch = parts[2].match(/([\d.]+)(\w+)/);
        let memMB = 0;
        if (memMatch) {
          memMB = parseMemory(parseFloat(memMatch[1]), memMatch[2]);
        }
        
        containers[name] = { cpu, memMB };
      }
      
      if (Object.keys(containers).length > 0) {
        samples.push({ timestamp, containers });
        
        // Print current stats
        const line = Object.entries(containers)
          .map(([name, stats]) => `${name}: ${stats.cpu.toFixed(1)}% CPU, ${stats.memMB.toFixed(0)}MB`)
          .join(' | ');
        process.stdout.write(`\r${line}                    `);
      }
    } catch (e) {
      // Container might be stopping
    }
  }, 2000);
  
  // Save PID for stop command
  fs.writeFileSync(PID_FILE, process.pid.toString());
  
  // Handle shutdown
  const shutdown = () => {
    clearInterval(interval);
    console.log('\n\n📊 Generating summary...\n');
    
    if (samples.length === 0) {
      console.log('No data collected');
      process.exit(0);
    }
    
    // Calculate statistics
    const stats = {};
    for (const sample of samples) {
      for (const [name, data] of Object.entries(sample.containers)) {
        if (!stats[name]) {
          stats[name] = { cpuSamples: [], memSamples: [] };
        }
        stats[name].cpuSamples.push(data.cpu);
        stats[name].memSamples.push(data.memMB);
      }
    }
    
    const summary = {
      duration: samples.length > 0 ? samples[samples.length - 1].timestamp : 0,
      sampleCount: samples.length,
      containers: {},
    };
    
    for (const [name, data] of Object.entries(stats)) {
      const cpuSorted = [...data.cpuSamples].sort((a, b) => a - b);
      const memSorted = [...data.memSamples].sort((a, b) => a - b);
      
      summary.containers[name] = {
        cpu: {
          avg: average(data.cpuSamples),
          max: Math.max(...data.cpuSamples),
          p95: percentile(cpuSorted, 95),
        },
        memoryMB: {
          avg: average(data.memSamples),
          max: Math.max(...data.memSamples),
          p95: percentile(memSorted, 95),
        },
      };
    }
    
    // Save raw data
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ summary, samples }, null, 2));
    console.log(`💾 Raw data saved to: ${OUTPUT_FILE}\n`);
    
    // Print summary
    console.log('📊 Resource Usage Summary');
    console.log('=========================');
    console.log(`Duration: ${(summary.duration / 1000).toFixed(1)}s | Samples: ${summary.sampleCount}\n`);
    
    for (const [name, data] of Object.entries(summary.containers)) {
      console.log(`${name}:`);
      console.log(`  CPU:    avg=${data.cpu.avg.toFixed(1)}%  max=${data.cpu.max.toFixed(1)}%  p95=${data.cpu.p95.toFixed(1)}%`);
      console.log(`  Memory: avg=${data.memoryMB.avg.toFixed(0)}MB  max=${data.memoryMB.max.toFixed(0)}MB  p95=${data.memoryMB.p95.toFixed(0)}MB`);
    }
    
    // Estimate capacity
    console.log('\n💡 Capacity Estimate:');
    const m3wStats = summary.containers['m3w'];
    if (m3wStats) {
      const cpuHeadroom = 100 / m3wStats.cpu.max;
      const memLimit = 2048; // 2GB limit from docker-compose
      const memHeadroom = memLimit / m3wStats.memoryMB.max;
      
      console.log(`  At 100 VUs: CPU max ${m3wStats.cpu.max.toFixed(1)}%, Memory max ${m3wStats.memoryMB.max.toFixed(0)}MB`);
      console.log(`  Theoretical max VUs (CPU bound): ~${Math.floor(100 * cpuHeadroom)}`);
      console.log(`  Theoretical max VUs (Memory bound): ~${Math.floor(100 * memHeadroom)}`);
    }
    
    // Cleanup
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function average(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

// Run
monitor();
