import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const project = read("ios/project.yml");
const dayStory = read("ios/Sources/Features/Timeline/DayStorySection.swift");
const timeline = read("ios/Sources/Features/Timeline/TimelineView.swift");
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
assert.match(
  timeline,
  /PhotosPicker\([\s\S]*?photoLibrary:\s*\.shared\(\)[\s\S]*?\)\s*\{/,
  "media picker must provide stable photo library item identifiers",
);
assert.match(
  timeline,
  /PhotosPicker\([\s\S]*?photoLibrary:\s*\.shared\(\)[\s\S]*?\)\s*\{\s*Image\(systemName:\s*"plus"\)[\s\S]*?\}\s*\.buttonStyle\(\.glassProminent\)\s*\.buttonBorderShape\(\.circle\)/,
  "upload picker must be an icon-only circular prominent glass button",
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
]) {
  assert.ok(swift.includes(symbol), `missing iOS contract symbol: ${symbol}`);
}

assert.ok(!swift.includes("AVEncoderBitRateKey"), "audio must never be re-encoded");

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
assert.match(appIconContents, /"filename"\s*:\s*"AppIcon-1024\.png"/);
assert.match(brandMarkContents, /"filename"\s*:\s*"BrandMark@3x\.png"/);
assert.match(login, /Image\("BrandMark"\)/);

console.log("iOS source contract: PASS");
