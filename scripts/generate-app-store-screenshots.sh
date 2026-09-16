#!/bin/bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
output_directory="${AFTERIMAGE_SCREENSHOT_OUTPUT_DIR:-$repository_root/artifacts/app-store/screenshots}"
result_bundle="${AFTERIMAGE_SCREENSHOT_RESULT_BUNDLE:-$repository_root/artifacts/app-store/AppStoreScreenshots.xcresult}"
build_log="${AFTERIMAGE_SCREENSHOT_BUILD_LOG:-$repository_root/artifacts/app-store/xcodebuild-screenshots.log}"
device_name="${AFTERIMAGE_SCREENSHOT_DEVICE_NAME:-iPhone 16 Pro Max}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "App Store screenshot generation requires self-hosted macOS with Xcode." >&2
  exit 1
fi

for command in xcodegen xcodebuild xcrun python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 1
  fi
done

device_id="$(
  xcrun simctl list devices available -j |
    python3 -c 'import json, sys
payload = json.load(sys.stdin)
name = sys.argv[1]
matches = [
    device["udid"]
    for runtime, devices in payload["devices"].items()
    if "iOS-26" in runtime
    for device in devices
    if device.get("isAvailable") and device["name"] == name
]
if len(matches) != 1:
    raise SystemExit(f"expected exactly one available iOS 26 {name} simulator, found {len(matches)}")
print(matches[0])' "$device_name"
)"

cleanup_status_bar() {
  xcrun simctl status_bar "$device_id" clear >/dev/null 2>&1 || true
}

trap cleanup_status_bar EXIT
xcrun simctl boot "$device_id" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$device_id" -b
xcrun simctl status_bar "$device_id" override \
  --time 9:41 \
  --dataNetwork wifi \
  --wifiBars 3 \
  --cellularBars 4 \
  --batteryState charged \
  --batteryLevel 100

mkdir -p "$output_directory" "$(dirname "$result_bundle")" "$(dirname "$build_log")"
if [[ -e "$result_bundle" ]]; then
  echo "Result bundle already exists: $result_bundle" >&2
  exit 1
fi
for filename in \
  01-private-timeline.png \
  02-memory-detail.png \
  03-ai-analysis.png
do
  if [[ -e "$output_directory/$filename" ]]; then
    echo "Screenshot already exists: $output_directory/$filename" >&2
    echo "Use a new artifact directory to preserve evidence immutability." >&2
    exit 1
  fi
done

(
  cd "$repository_root/ios"
  xcodegen generate
  set -o pipefail
  TEST_RUNNER_AFTERIMAGE_SCREENSHOT_OUTPUT_DIR="$output_directory" xcodebuild test \
    -project afterimage.xcodeproj \
    -scheme afterimage \
    -destination "platform=iOS Simulator,id=$device_id" \
    -derivedDataPath DerivedData \
    -resultBundlePath "$result_bundle" \
    -only-testing:afterimageUITests/AppStoreScreenshotUITests/testCaptureAppStoreScreenshots \
    -parallel-testing-enabled NO \
    -maximum-concurrent-test-simulator-destinations 1 \
    -jobs 1 \
    -collect-test-diagnostics never \
    CODE_SIGNING_ALLOWED=NO \
    CC="$repository_root/scripts/xcode-clang-probe" |
    tee "$build_log"
)

node "$repository_root/scripts/verify-app-store.mjs" \
  --mode screenshots \
  --screenshots-dir "$output_directory" \
  --report "$output_directory/verification.json"
