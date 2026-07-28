import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const project = read("ios/project.yml");
const info = read("ios/Resources/Info.plist");
const entitlements = read("ios/Resources/afterimage.entitlements");
const dayStory = read("ios/Sources/Features/Timeline/DayStorySection.swift");
const [dayStorySection, dayStoryHero = ""] = dayStory.split("private struct DayStoryHero");
const weatherBadge = read("ios/Sources/Features/Timeline/DailyWeatherBadge.swift");
const timeline = read("ios/Sources/Features/Timeline/TimelineView.swift");
const apiClient = read("ios/Sources/Networking/APIClient.swift");
const apiModels = read("ios/Sources/Models/APIModels.swift");
const mediaImporter = read("ios/Sources/Import/MediaImporter.swift");
const privacy = read("ios/Resources/PrivacyInfo.xcprivacy");
const login = read("ios/Sources/Features/Auth/LoginView.swift");
const appIconContents = read("ios/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json");
const brandMarkContents = read("ios/Resources/Assets.xcassets/BrandMark.imageset/Contents.json");
const appIcon = readFileSync(
  path.join(root, "ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"),
);
const sourceRoot = path.join(root, "ios/Sources");
const swift = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
  .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
  .join("\n");

assert.match(project, /PRODUCT_NAME:\s*afterimage/);
assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET:\s*["']?26\.0/);
assert.match(project, /path:\s*Resources\/PrivacyInfo\.xcprivacy\s*\n\s+buildPhase:\s*resources/);
assert.match(info, /<key>NSLocationWhenInUseUsageDescription<\/key>/);
assert.match(info, /<key>NSCameraUsageDescription<\/key>/);
assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>/);
assert.match(entitlements, /<key>com\.apple\.developer\.weatherkit<\/key>\s*<true\/>/);
assert.match(weatherBadge, /\.symbolRenderingMode\(\.hierarchical\)/);
assert.match(weatherBadge, /\.tint\(\.secondary\)/);
assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
for (const category of [
  "NSPrivacyCollectedDataTypeName",
  "NSPrivacyCollectedDataTypeEmailAddress",
  "NSPrivacyCollectedDataTypeUserID",
  "NSPrivacyCollectedDataTypePhotosorVideos",
]) {
  assert.ok(privacy.includes(category), `missing privacy declaration: ${category}`);
}
assert.ok(!swift.includes("#available"), "iOS 26-only app must not carry legacy availability branches");
assert.ok(!swift.includes("ultraThinMaterial"), "iOS 26-only app must not carry a Material fallback");
assert.match(
  dayStory,
  /Color\(\.tertiarySystemFill\)[\s\S]*?\.aspectRatio\(4\.0\s*\/\s*3\.0,\s*contentMode:\s*\.fit\)[\s\S]*?\.overlay\s*\{[\s\S]*?AuthenticatedThumbnail\(asset:\s*asset\)/,
  "day story hero must use an intrinsic-size-free container",
);
assert.match(
  dayStory,
  /Color\(\.tertiarySystemFill\)[\s\S]*?\.frame\(width:\s*64,\s*height:\s*64\)[\s\S]*?\.overlay\s*\{[\s\S]*?AuthenticatedThumbnail\(asset:\s*asset\)/,
  "day story strip cells must use an intrinsic-size-free container",
);
assert.doesNotMatch(
  dayStory,
  /AuthenticatedThumbnail\(asset:\s*asset\)[\s\S]{0,240}?\.aspectRatio\([\s\S]{0,40}?contentMode:\s*\.fill\)/,
  "thumbnail aspect ratios must not participate in layout sizing",
);
assert.doesNotMatch(
  swift,
  /opensMaps:\s*false/,
  "every displayed capture location must link to Apple Maps",
);
assert.match(
  dayStorySection,
  /story\.hero\.location[\s\S]*?CaptureLocationChip\(location:\s*location\)/,
  "timeline location must be a standalone Apple Maps link",
);
assert.doesNotMatch(
  dayStoryHero,
  /CaptureLocationChip/,
  "timeline location link must not be nested inside the hero NavigationLink",
);
assert.match(
  dayStorySection,
  /if let summary = dailySummary\?\.summary[\s\S]*?Text\(verbatim:\s*summary\)[\s\S]*?\.lineLimit\(3\)/,
  "the generated daily summary must be shown above the hero and capped at three lines",
);
assert.doesNotMatch(
  dayStorySection,
  /story\.quote/,
  "raw transcript quotes must not be rendered in the timeline",
);
assert.match(apiModels, /struct DailySummaryResponse:\s*Codable,\s*Equatable,\s*Sendable/);
assert.match(apiClient, /components\.path\s*=\s*"\/v1\/days\/summary"/);
assert.match(
  timeline,
  /PhotosPicker\([\s\S]*?photoLibrary:\s*\.shared\(\)[\s\S]*?\)\s*\{/,
  "media picker must provide stable photo library item identifiers",
);
assert.match(
  timeline,
  /Menu\s*\{[\s\S]*?PhotosPicker\([\s\S]*?photoLibrary:\s*\.shared\(\)[\s\S]*?\}\s*\}\s*label:\s*\{\s*Image\(systemName:\s*"plus"\)[\s\S]*?\}\s*\.buttonStyle\(\.glassProminent\)\s*\.buttonBorderShape\(\.circle\)/,
  "upload source menu must be an icon-only circular prominent glass button",
);
assert.doesNotMatch(
  mediaImporter,
  /PHAsset\.fetchAssets/,
  "media import must not request full photo library access",
);
assert.doesNotMatch(
  timeline,
  /upload\.duplicates\.hint_(?:title|detail)/,
  "upload dock must not show a permanent duplicate-upload hint",
);
assert.match(timeline, /matching:\s*\.videos/, "media picker must show only videos");
assert.doesNotMatch(timeline, /matching:[^\n]*\.images/, "media picker must not show images");
assert.match(timeline, /\.accessibilityLabel\("動画を追加"\)/, "media picker label must describe video-only selection");
assert.doesNotMatch(timeline, /写真や動画を(?:追加|選ぶ)/, "timeline copy must describe video-only selection");
for (const symbol of [
  "GlassEffectContainer",
  ".glassEffect",
  "CHHapticEngine",
  "SignInWithAppleButton",
  "PhotosPicker",
  "loadTransferable",
  "FileHandle",
  "AVVideoCodecType.hevc",
  "PumpCancellationRelay",
  "AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)",
  "AVAssetWriterInput(mediaType: .audio, outputSettings: nil",
  "CGImageDestinationLossyCompressionQuality",
  "partUrlTemplate",
  "replacingOccurrences(of: \"{partNumber}\"",
  "/upload/complete",
  "AVPlayer",
  "AVPlayerLayer",
  "navigationTransition",
  "matchedTransitionSource",
  "/playback",
  "resolver.isAPIOrigin(url)",
  "/v1/auth/session",
  "CLLocationUpdate.liveUpdates",
  "WeatherService.shared",
  "AVCaptureMovieFileOutput",
  "AVCaptureVideoPreviewLayer",
  "AVCaptureDevice.RotationCoordinator",
]) {
  assert.ok(swift.includes(symbol), `missing iOS contract symbol: ${symbol}`);
}

assert.ok(!swift.includes("AVEncoderBitRateKey"), "audio must never be re-encoded");


function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upLeft;
}

function decodeOneBitPng(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  assert.equal(bitDepth, 1, "app icon must use 1-bit pixels");
  assert.equal(colorType, 3, "app icon must use indexed color");

  const compressed = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  const rowBytes = Math.ceil(width * bitDepth / 8);
  const encoded = inflateSync(Buffer.concat(compressed));
  assert.equal(encoded.length, height * (rowBytes + 1));
  const rows = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (rowBytes + 1);
    const rowOffset = y * rowBytes;
    const filter = encoded[sourceOffset];
    for (let x = 0; x < rowBytes; x += 1) {
      const value = encoded[sourceOffset + 1 + x];
      const left = x > 0 ? rows[rowOffset + x - 1] : 0;
      const up = y > 0 ? rows[rowOffset - rowBytes + x] : 0;
      const upLeft = y > 0 && x > 0 ? rows[rowOffset - rowBytes + x - 1] : 0;
      const predictor = [
        0,
        left,
        up,
        Math.floor((left + up) / 2),
        paeth(left, up, upLeft),
      ][filter];
      assert.notEqual(predictor, undefined, "unsupported PNG filter");
      rows[rowOffset + x] = (value + predictor) & 0xff;
    }
  }

  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = rows[y * rowBytes + (x >> 3)];
      pixels[y * width + x] = (byte >> (7 - (x & 7))) & 1;
    }
  }
  return { width, height, pixels };
}

function foregroundComponentCount({ width, height, pixels }) {
  const background = pixels[0];
  const visited = new Uint8Array(pixels.length);
  const queue = new Int32Array(pixels.length);
  let components = 0;

  for (let origin = 0; origin < pixels.length; origin += 1) {
    if (pixels[origin] === background || visited[origin]) continue;
    components += 1;
    let head = 0;
    let tail = 0;
    queue[tail] = origin;
    tail += 1;
    visited[origin] = 1;
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
          if (xOffset === 0 && yOffset === 0) continue;
          const nextX = x + xOffset;
          const nextY = y + yOffset;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const neighbor = nextY * width + nextX;
          if (visited[neighbor] || pixels[neighbor] === background) continue;
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }
  }
  return components;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert.ok(appIcon.subarray(0, 8).equals(pngSignature), "app icon must be a PNG");
assert.equal(appIcon.readUInt32BE(16), 1024, "app icon width must be 1024 px");
assert.equal(appIcon.readUInt32BE(20), 1024, "app icon height must be 1024 px");
assert.equal(appIcon.indexOf(Buffer.from("tRNS")), -1, "app icon must not contain transparency");
const paletteOffset = appIcon.indexOf(Buffer.from("PLTE"));
assert.notEqual(paletteOffset, -1, "app icon must use a fixed monochrome palette");
assert.equal(
  appIcon.readUInt32BE(paletteOffset - 4) / 3,
  2,
  "app icon must contain exactly two flat colors",
);
assert.equal(
  foregroundComponentCount(decodeOneBitPng(appIcon)),
  3,
  "app icon mark must contain two slashes and one connected A",
);
assert.match(appIconContents, /"filename"\s*:\s*"AppIcon-1024\.png"/);
assert.match(brandMarkContents, /"filename"\s*:\s*"BrandMark@3x\.png"/);
assert.match(login, /Image\("BrandMark"\)/);

console.log("iOS source contract: PASS");
