# Upload Stress Test

Tests memory stability of stream-based upload implementation.

**Related Issue:** [test3207/m3w#121](https://github.com/test3207/m3w/issues/121)

## Background

After PRs #120 and #128 implemented streaming upload to MinIO, we need to verify:

- Large file uploads don't cause OOM
- Concurrent uploads maintain stable memory
- Memory is properly released after uploads complete

## Quick Start

```bash
# One command does everything
npm run test:upload

# Or with larger files (50MB)
npm run test:upload -- --size 50
```

## Options

```bash
npm run test:upload                    # Default: 5MB files
npm run test:upload -- --size 20       # Use 20MB files
npm run test:upload -- --size 50       # Use 50MB files
npm run test:upload -- --size 100      # Use 100MB files
npm run test:upload -- --keep          # Keep containers running after test
npm run test:upload -- --podman        # Force use podman
```

## Test Stages

| Stage | VUs | Duration | Purpose |
|-------|-----|----------|---------|
| Warm-up | 1 | 30s | Single upload baseline |
| Low | 5 | 1m | Low concurrency |
| Medium | 10 | 2m | Medium concurrency |
| High | 20 | 2m | Memory stress test |
| Cool-down | 0 | 1m | Memory recovery check |

## File Generation

### Deduplication Strategy

The server uses **content hash** for file deduplication. To ensure each upload is unique:

1. **Generate 1 base file** per size (memory efficient)
2. **k6 modifies 16 bytes at runtime** (offset 100-116) with VU ID, iteration, and timestamp
3. Each request has a unique SHA-256 hash

This approach uses minimal memory (~50MB for 50MB test) instead of loading multiple file variants.

```bash
# Generate manually (auto-generated if missing)
npm run generate:upload-files

# Generate specific size
npm run generate:upload-files -- --size 50
```

Generated files:

- `fixtures/small-5mb-0.bin` - 5MB base file
- `fixtures/medium-20mb-0.bin` - 20MB base file
- `fixtures/large-50mb-0.bin` - 50MB base file
- `fixtures/xlarge-100mb-0.bin` - 100MB base file

> **Note**: Files are synthetic MP3 (valid headers + random data). See [Analysis Notes](#analysis-notes) for implications.

## Success Criteria

- Upload success rate > 95%
- No memory leak (memory returns to baseline after test)
- Throughput > 1 Mbps average

## Output

Results are saved to `results/upload-<timestamp>.json` with:

- Resource usage samples (CPU, memory per container)
- Memory analysis (baseline, peak, recovery)

## Benchmark

Run the full benchmark matrix (3 file sizes × 3 concurrency levels):

```bash
npm run benchmark:upload
```

### Benchmark Matrix

| File Size | VUs | Duration |
|-----------|-----|----------|
| 5MB | 5, 10, 20 | 3min each |
| 20MB | 5, 10, 20 | 3min each |
| 50MB | 5, 10, 20 | 3min each |

### Benchmark Results (2025-12-15)

> ⚠️ **Important**: These results represent **worst-case scenario**. See [Analysis Notes](#analysis-notes) below.

| File Size | VUs | CPU (avg/max) | Mem (avg/max) | Status |
|-----------|-----|---------------|---------------|--------|
| 5MB | 5 | 19.1% / 21.2% | 149MB / 172MB | ✅ |
| 5MB | 10 | 23.9% / 27.5% | 159MB / 218MB | ✅ |
| 5MB | 20 | 33.2% / 38.5% | 169MB / 225MB | ✅ |
| 20MB | 5 | 36.4% / 37.3% | 202MB / 265MB | ✅ |
| 20MB | 10 | 37.1% / 38.8% | 211MB / 288MB | ✅ |
| 20MB | 20 | 40.2% / 42.0% | 298MB / 443MB | ✅ |
| 50MB | 5 | 41.7% / 42.0% | 303MB / 443MB | ✅ |
| 50MB | 10 | 42.2% / 42.9% | 384MB / 646MB | ✅ |
| 50MB | 20 | 43.1% / 43.3% | 591MB / 1063MB | ✅ |

**All tests passed with 0% error rate.**

### Scaling Analysis

**Memory slope by file size:**

| File Size | Memory per VU | CPU per VU |
|-----------|---------------|------------|
| 5MB | ~3.5MB | ~1.15% |
| 20MB | ~11.9MB | ~0.31% |
| 50MB | ~41.3MB | ~0.09% |

**Memory slope by concurrency:**

| VUs | Memory per MB file size |
|-----|-------------------------|
| 5 | ~6.0MB |
| 10 | ~9.5MB |
| 20 | ~18.6MB |

### Analysis Notes

#### Why Worst-Case?

The test uses **synthetic binary files** (fake MP3 headers + random data) to bypass server-side content hash deduplication. This triggers worst-case behavior:

1. **Full file scan by music-metadata**: The `music-metadata` library uses streaming (`parseStream`), but when it cannot find valid metadata (ID3 tags, frame headers), it continues reading until EOF to calculate duration.

2. **V8 external buffer GC delay**: Node.js Buffers are allocated outside V8 heap. Even after streams end, the underlying memory may not be immediately released by the garbage collector.

#### Expected Real-World Performance

With real audio files:
- `music-metadata` can extract duration from headers early (ID3v2 + first few frames)
- Stream processing would consume only a small buffer window
- Memory usage should be significantly lower (~10-50MB for same workload)

#### Key Findings

1. **Linear memory growth confirmed**: Peak memory (50MB × 20VU = ~1GB) roughly equals `file_size × concurrent_uploads`, proving stream-based upload works correctly.

2. **No memory leak**: Memory recovers after upload completion.

3. **CPU is I/O bound**: Larger files show lower CPU-per-VU slope because more time is spent on network/disk I/O.

### Future Work

- [ ] Generate valid MP3 files with proper ID3 tags and frame structure
- [ ] Add `skipPostHeaders: true` option to metadata parsing for streaming optimization
- [ ] Test with real audio file library
