# M3W Load Test

Load testing suite for [M3W](https://github.com/test3207/m3w) - k6 scripts for capacity and performance testing.

## Overview

This repository contains load testing infrastructure to:

- Determine maximum concurrent users for given resources
- Identify performance bottlenecks
- Establish baseline metrics for optimization

## Structure

```Text
m3w-load-test/
├── docker-compose.yml       # Complete test environment (M3W + PostgreSQL + MinIO)
├── scripts/
│   ├── seed.cjs             # Test data preparation
│   └── cleanup.cjs          # Cleanup script
├── k6/
│   ├── config.js            # Shared configuration
│   └── capacity.js          # User capacity test
├── results/                 # Test reports (gitignored)
└── README.md
```

## Test Design

### User Behavior Model

| Phase | Weight | Actions |
|-------|--------|---------|
| Startup | 5% | Auth, list libraries/playlists |
| Listening | 85% | Stream audio, update progress every 30s |
| Managing | 10% | Create/delete playlists |

### Load Stages

| Stage | VUs | Duration |
|-------|-----|----------|
| Warm-up | 1 | 1 min |
| Baseline | 10 | 3 min |
| Load | 25 | 3 min |
| Stress | 50 | 3 min |
| Peak | 100 | 3 min |

### Success Criteria

- API response p95 < 500ms
- Audio stream TTFB < 200ms
- Error rate < 1%

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) installed
- Docker & Docker Compose
- Node.js 20+ (for seed scripts)

## Quick Start

```bash
# 1. Start test environment
docker compose up -d

# 2. Seed test data
node scripts/seed.cjs

# 3. Run capacity test
k6 run k6/capacity.js

# 4. Cleanup
node scripts/cleanup.cjs
docker compose down
```

## Configuration

Environment variables for k6 scripts:

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:4000` | M3W API base URL |
| `TEST_USER_TOKEN` | - | Auth token for API requests |

## Related

- [M3W Main Repository](https://github.com/test3207/m3w)
- Parent Issue: [test3207/m3w#180](https://github.com/test3207/m3w/issues/180)
