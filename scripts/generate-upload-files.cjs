/**
 * Generate test files for upload stress testing
 * 
 * Creates various sizes of test files for memory stress testing:
 * - small-5mb.bin    - baseline
 * - medium-20mb.bin  - moderate size
 * - large-50mb.bin   - large file test
 * - xlarge-100mb.bin - stress test
 * 
 * Files are binary with minimal MP3 structure (valid enough for upload).
 * The server may or may not process them correctly, but that's fine -
 * we're testing memory stability, not audio parsing.
 * 
 * Usage:
 *   node scripts/generate-upload-files.cjs
 *   node scripts/generate-upload-files.cjs --size 50  # Generate 50MB only
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// Seed for random generation - use command line arg or timestamp
const SEED = process.argv.find(a => a.startsWith('--seed='))?.split('=')[1] || Date.now().toString();
console.log(`Using seed: ${SEED}\n`);

// File sizes to generate (MB)
const FILE_SIZES = [
  { name: 'small-5mb', sizeMB: 5 },
  { name: 'medium-20mb', sizeMB: 20 },
  { name: 'large-50mb', sizeMB: 50 },
  { name: 'xlarge-100mb', sizeMB: 100 },
];

// Number of variants - only need 1 now since k6 modifies bytes at runtime
// This keeps memory usage minimal (~5MB for 5MB file)
const VARIANTS_COUNT = parseInt(process.env.VARIANTS_COUNT || '1');

/**
 * Generate a minimal MP3-like file
 * Uses valid MP3 frame header + random data to create somewhat valid MP3
 * that upload endpoint will accept
 */
function generateMp3File(sizeMB, variant = 0) {
  const targetBytes = sizeMB * 1024 * 1024;
  
  // MP3 frame header for 128kbps, 44100Hz, stereo
  const frameHeader = Buffer.from([0xFF, 0xFB, 0x90, 0x00]);
  const frameDataSize = 417 - 4; // Frame size minus header
  const frameSize = 417;
  
  const numFrames = Math.ceil(targetBytes / frameSize);
  const chunks = [];
  
  // Add minimal ID3v2 header with unique title
  chunks.push(createMinimalId3Tag(sizeMB, variant));
  
  // Generate frames with random data
  console.log(`  Generating ${numFrames} frames...`);
  
  // Generate in batches to avoid memory issues
  const batchSize = 10000;
  for (let batch = 0; batch < Math.ceil(numFrames / batchSize); batch++) {
    const framesInBatch = Math.min(batchSize, numFrames - batch * batchSize);
    const batchBuffer = Buffer.alloc(framesInBatch * frameSize);
    
    for (let i = 0; i < framesInBatch; i++) {
      const offset = i * frameSize;
      // Frame header
      frameHeader.copy(batchBuffer, offset);
      // Use crypto for random data (seeded by hash of seed + variant + position)
      const hash = crypto.createHash('md5').update(`${SEED}-${sizeMB}-${variant}-${batch}-${i}`).digest();
      for (let j = 4; j < frameSize; j++) {
        batchBuffer[offset + j] = hash[j % hash.length];
      }
    }
    
    chunks.push(batchBuffer);
  }
  
  return Buffer.concat(chunks);
}

/**
 * Create minimal ID3v2.3 tag for metadata
 */
function createMinimalId3Tag(sizeMB, variant) {
  // Each file must have a unique title to avoid server-side deduplication
  const title = `Test ${SEED}-${sizeMB}MB-v${variant}`;
  const artist = 'M3W Load Test';
  
  const frames = [];
  
  // TIT2 - Title
  frames.push(createId3Frame('TIT2', title));
  // TPE1 - Artist
  frames.push(createId3Frame('TPE1', artist));
  
  const framesBuffer = Buffer.concat(frames);
  const size = framesBuffer.length;
  
  // ID3v2.3 header (syncsafe integer for size)
  const header = Buffer.from([
    0x49, 0x44, 0x33, // "ID3"
    0x03, 0x00,       // Version 2.3
    0x00,             // Flags
    (size >> 21) & 0x7F,
    (size >> 14) & 0x7F,
    (size >> 7) & 0x7F,
    size & 0x7F,
  ]);
  
  return Buffer.concat([header, framesBuffer]);
}

function createId3Frame(frameId, text) {
  const textBuffer = Buffer.from(text, 'utf8');
  const size = textBuffer.length + 1;
  
  return Buffer.concat([
    Buffer.from(frameId, 'ascii'),
    Buffer.from([
      (size >> 24) & 0xFF,
      (size >> 16) & 0xFF,
      (size >> 8) & 0xFF,
      size & 0xFF,
      0x00, 0x00, // Flags
      0x00,       // Encoding
    ]),
    textBuffer,
  ]);
}

/**
 * Generate all test files
 */
async function generateFiles() {
  console.log('🎵 M3W Upload Test - File Generator');
  console.log('====================================\n');
  
  // Ensure fixtures directory exists
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }
  
  // Parse CLI args for specific size
  const args = process.argv.slice(2);
  let targetSize = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--size' && args[i + 1]) {
      targetSize = parseInt(args[i + 1]);
      break;
    }
  }
  
  const filesToGenerate = targetSize 
    ? FILE_SIZES.filter(f => f.sizeMB === targetSize)
    : FILE_SIZES;
  
  if (filesToGenerate.length === 0) {
    console.log(`No matching size found for ${targetSize}MB`);
    console.log(`Available sizes: ${FILE_SIZES.map(f => f.sizeMB).join(', ')}MB`);
    process.exit(1);
  }
  
  for (const { name, sizeMB } of filesToGenerate) {
    // Generate multiple variants to avoid deduplication (server uses content hash)
    // Always regenerate with current seed to ensure unique content
    console.log(`📦 Generating ${name}-*.bin (${sizeMB}MB x ${VARIANTS_COUNT})...`);
    
    for (let variant = 0; variant < VARIANTS_COUNT; variant++) {
      const fileName = `${name}-${variant}.bin`;
      const filePath = path.join(FIXTURES_DIR, fileName);
      
      const startTime = Date.now();
      const data = generateMp3File(sizeMB, variant);
      fs.writeFileSync(filePath, data);
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`   [${variant + 1}/${VARIANTS_COUNT}] `);
      console.log(`${fileName} (${duration}s)`);
    }
    console.log('');
  }
  
  console.log('\n📋 Generated files:');
  for (const { name, sizeMB } of filesToGenerate) {
    const filePath = path.join(FIXTURES_DIR, `${name}-0.bin`);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const actualSize = (stats.size / 1024 / 1024).toFixed(1);
      console.log(`   fixtures/${name}-[0-${VARIANTS_COUNT-1}].bin - ${actualSize}MB each`);
    }
  }
  
  console.log('\n💡 Usage:');
  console.log('   npm run test:upload             # Full test with 5MB files');
  console.log('   npm run test:upload -- --size 50  # Test with 50MB files');
}

generateFiles().catch(console.error);
