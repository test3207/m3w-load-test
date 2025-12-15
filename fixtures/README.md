# Test Audio Fixtures

Place sample audio files here for automatic upload during seed.

Supported formats:

- `.mp3`
- `.flac`
- `.m4a`

The seed script will upload all audio files in this directory to the "Load Test Library".

## Recommended Test Files

For meaningful load testing, include files of various sizes:

- Small: ~3MB (typical single track)
- Medium: ~10MB (high quality track)
- Large: ~15MB (lossless/FLAC)

## Note

Audio files are gitignored to avoid repository bloat.
