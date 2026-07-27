# AGENTS.md

## Product

Afterimage is an iOS-first private lifelog. The first vertical slice imports photos/videos, compresses media on-device (HEVC video with untouched passthrough audio; HEIC photos), stores only optimized media in private Cloudflare R2, and provides an authenticated timeline and playback API. AI transcription/search comes after the storage and privacy boundary is proven.

## Repository layout

- `backend/`: Hono API on Cloudflare Workers, D1 metadata, private R2 media.
- `ios/`: SwiftUI iOS 26-only app generated with XcodeGen.
- `.github/workflows/`: backend and iOS CI.

## Non-negotiable rules

1. RED -> GREEN -> REFACTOR. Add a failing behavior test before production code.
2. Media is private by default. Every metadata, upload, thumbnail, content, and delete route enforces owner-scoped auth.
3. Never commit Apple keys, Cloudflare account/resource IDs, R2 credentials, bearer tokens, `.dev.vars`, or generated deployment config.
4. Do not buffer unbounded media in Workers. Stream single uploads and multipart parts to R2.
5. Complete uploads only after R2 size verification. Treat signed URLs and bearer sessions as secrets.
6. iOS is iOS 26-only: use native Liquid Glass directly, with no `#available` or legacy Material fallback. Sessions live in Keychain, imports use file-based `Transferable`, and large video is never loaded fully into memory.
7. Report what was actually built and tested; Linux cannot substitute for an Xcode build. Use macOS CI for the iOS build gate.
8. R2 receives only optimized media. Re-encode video to HEVC while copying compressed audio samples with nil reader/writer output settings; never fall back to an audio re-encode or silently upload the original on conversion failure.
9. iOS GitHub Actions jobs run on the repo-scoped MacBook runner using `[self-hosted, macOS, ARM64, afterimage-ios]`. Do not switch them back to GitHub-hosted macOS runners without explicit approval.

## Verification

```bash
npm ci
npm run check
```

On macOS:

```bash
cd ios
xcodegen generate
xcodebuild test -scheme Afterimage -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
```
