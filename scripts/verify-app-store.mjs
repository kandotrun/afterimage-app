import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const expectedDeviceTargets = ["afterimage", "AfterimageUploadWidget"];
const expectedPrivacyDataTypes = [
  "NSPrivacyCollectedDataTypePreciseLocation",
  "NSPrivacyCollectedDataTypeAudioData",
  "NSPrivacyCollectedDataTypePhotosorVideos",
  "NSPrivacyCollectedDataTypeUserID",
  "NSPrivacyCollectedDataTypeName",
  "NSPrivacyCollectedDataTypeEmailAddress",
  "NSPrivacyCollectedDataTypeOtherUserContent",
];
const expectedDimensions = [
  { width: 1260, height: 2736 },
  { width: 1290, height: 2796 },
  { width: 1320, height: 2868 },
];
const expectedEvidenceIDs = [
  "AUTH_CHALLENGE",
  "ACCOUNT_DELETION",
  "AI_CONSENT",
  "LEGAL_PRIVACY",
  "LEGAL_SUPPORT",
  "LEGAL_TERMS",
  "BACKEND_MIGRATIONS",
  "IOS_TESTS",
  "REAL_DEVICE_SMOKE",
  "SCREENSHOTS_69",
  "ARCHIVE_EXPORT",
  "ASC_PREFLIGHT",
  "REQUIRED_REASON_API",
  "SECRET_SCAN",
  "REVIEW_CLEARANCE",
];
const evidencePolicies = {
  AUTH_CHALLENGE: [[".github/workflows/backend.yml", "backend"]],
  ACCOUNT_DELETION: [[".github/workflows/backend.yml", "backend"]],
  AI_CONSENT: [[".github/workflows/backend.yml", "backend"]],
  LEGAL_PRIVACY: [[".github/workflows/release-attestation.yml", "production"]],
  LEGAL_SUPPORT: [[".github/workflows/release-attestation.yml", "production"]],
  LEGAL_TERMS: [[".github/workflows/release-attestation.yml", "production"]],
  BACKEND_MIGRATIONS: [[".github/workflows/release-attestation.yml", "production"]],
  IOS_TESTS: [
    [".github/workflows/ios.yml", "ios"],
    [".github/workflows/ios-deploy.yml", "test"],
  ],
  REAL_DEVICE_SMOKE: [[".github/workflows/release-attestation.yml", "real-device-smoke"]],
  SCREENSHOTS_69: [[".github/workflows/app-store-screenshots.yml", "capture"]],
  ARCHIVE_EXPORT: [[".github/workflows/ios-deploy.yml", "deploy"]],
  ASC_PREFLIGHT: [[".github/workflows/ios-deploy.yml", "deploy"]],
  REQUIRED_REASON_API: [[".github/workflows/ios-deploy.yml", "deploy"]],
  SECRET_SCAN: [[".github/workflows/release-attestation.yml", "secret-scan"]],
  REVIEW_CLEARANCE: [[".github/workflows/release-attestation.yml", "review-clearance"]],
};
const expectedLegalURLs = {
  privacy: "https://afterimage.2-38.com/privacy",
  support: "https://afterimage.2-38.com/support",
  terms: "https://afterimage.2-38.com/terms",
};
const expectedRunner = "[self-hosted, macOS, ARM64, afterimage-ci]";

const failure = (id, message) => ({ id, message });
const normalizedLines = (value) => value.replaceAll("\r\n", "\n").split("\n");
const leadingSpaces = (line) => line.length - line.trimStart().length;
const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

function extractYamlBlock(source, key, indentation = 0) {
  const lines = normalizedLines(source);
  const prefix = " ".repeat(indentation);
  const start = lines.findIndex((line) => line === `${prefix}${key}:`);
  if (start === -1) return [];
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && leadingSpaces(line) <= indentation) break;
    block.push(line);
  }
  return block;
}

function extractTargetBlock(project, targetName) {
  const targets = extractYamlBlock(project, "targets");
  const targetLine = `  ${targetName}:`;
  const start = targets.findIndex((line) => line === targetLine);
  if (start === -1) return [];
  const block = [];
  for (let index = start + 1; index < targets.length; index += 1) {
    const line = targets[index];
    if (line.trim() && leadingSpaces(line) <= 2) break;
    block.push(line);
  }
  return block;
}

export function verifyTargetFamilies(project) {
  const failures = [];
  for (const target of expectedDeviceTargets) {
    const block = extractTargetBlock(project, target);
    if (block.length === 0) {
      failures.push(failure(
        `target.${target}.missing`,
        `ios/project.yml に ${target} target がありません。`,
      ));
      continue;
    }
    const declarations = block
      .map((line) => line.trim())
      .filter((line) => line.startsWith("TARGETED_DEVICE_FAMILY:"))
      .map((line) => unquote(line.slice(line.indexOf(":") + 1)));
    if (declarations.length !== 1 || declarations[0] !== "1") {
      failures.push(failure(
        `target.${target}.device-family`,
        `${target} は target 自身の settings で TARGETED_DEVICE_FAMILY="1" を一度だけ宣言する必要があります。`,
      ));
    }
  }

  for (const line of normalizedLines(project)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TARGETED_DEVICE_FAMILY:")) continue;
    const value = unquote(trimmed.slice(trimmed.indexOf(":") + 1));
    if (value !== "1") {
      failures.push(failure(
        "target.accidental-ipad",
        `iPad を含む TARGETED_DEVICE_FAMILY=${JSON.stringify(value)} は許可されません。`,
      ));
    }
  }
  return failures;
}

function decodeXML(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tokenizePlist(xml) {
  const tokens = [];
  const pattern = /<\/?(?:plist|dict|array)>|<(key|string|integer)>([\s\S]*?)<\/\1>|<(true|false)\/>/g;
  const expanded = xml
    .replaceAll("<array/>", "<array></array>")
    .replaceAll("<dict/>", "<dict></dict>");
  for (const match of expanded.matchAll(pattern)) {
    const raw = match[0];
    if (raw === "<plist>" || raw.startsWith('<plist version="')) continue;
    if (raw === "</plist>") continue;
    if (raw === "<dict>") tokens.push({ type: "dict-start" });
    else if (raw === "</dict>") tokens.push({ type: "dict-end" });
    else if (raw === "<array>") tokens.push({ type: "array-start" });
    else if (raw === "</array>") tokens.push({ type: "array-end" });
    else if (match[1] === "key") tokens.push({ type: "key", value: decodeXML(match[2]) });
    else if (match[1] === "string") tokens.push({ type: "string", value: decodeXML(match[2]) });
    else if (match[1] === "integer") tokens.push({ type: "integer", value: Number(match[2]) });
    else if (match[3] === "true") tokens.push({ type: "boolean", value: true });
    else if (match[3] === "false") tokens.push({ type: "boolean", value: false });
  }
  return tokens;
}

function parsePlistElement(tokens, cursor) {
  const token = tokens[cursor.index];
  if (!token) throw new Error("unexpected end of plist");
  if (token.type === "dict-start") {
    cursor.index += 1;
    const result = {};
    while (tokens[cursor.index]?.type !== "dict-end") {
      const key = tokens[cursor.index];
      if (key?.type !== "key") throw new Error("expected plist key");
      cursor.index += 1;
      result[key.value] = parsePlistElement(tokens, cursor);
    }
    cursor.index += 1;
    return result;
  }
  if (token.type === "array-start") {
    cursor.index += 1;
    const result = [];
    while (tokens[cursor.index]?.type !== "array-end") {
      result.push(parsePlistElement(tokens, cursor));
    }
    cursor.index += 1;
    return result;
  }
  if (["string", "integer", "boolean"].includes(token.type)) {
    cursor.index += 1;
    return token.value;
  }
  throw new Error(`unsupported plist token: ${token.type}`);
}

function parsePlist(xml) {
  const tokens = tokenizePlist(xml);
  return parsePlistElement(tokens, { index: 0 });
}

export function verifyPrivacyManifest(xml) {
  const failures = [];
  let manifest;
  try {
    manifest = parsePlist(xml);
  } catch (error) {
    return [failure("privacy.parse", `PrivacyInfo.xcprivacy を解析できません: ${error.message}`)];
  }

  if (manifest.NSPrivacyTracking !== false) {
    failures.push(failure("privacy.tracking", "NSPrivacyTracking は false である必要があります。"));
  }
  if (!Array.isArray(manifest.NSPrivacyTrackingDomains)
      || manifest.NSPrivacyTrackingDomains.length !== 0) {
    failures.push(failure(
      "privacy.tracking-domains",
      "NSPrivacyTrackingDomains は空配列である必要があります。",
    ));
  }

  const declarations = Array.isArray(manifest.NSPrivacyCollectedDataTypes)
    ? manifest.NSPrivacyCollectedDataTypes
    : [];
  const byType = new Map(
    declarations.map((item) => [item.NSPrivacyCollectedDataType, item]),
  );
  for (const dataType of expectedPrivacyDataTypes) {
    const declaration = byType.get(dataType);
    if (!declaration) {
      failures.push(failure(
        `privacy.data.${dataType}`,
        `PrivacyInfo.xcprivacy に ${dataType} の宣言がありません。`,
      ));
      continue;
    }
    const purposes = declaration.NSPrivacyCollectedDataTypePurposes;
    if (declaration.NSPrivacyCollectedDataTypeLinked !== true
        || declaration.NSPrivacyCollectedDataTypeTracking !== false
        || !Array.isArray(purposes)
        || !purposes.includes("NSPrivacyCollectedDataTypePurposeAppFunctionality")) {
      failures.push(failure(
        `privacy.data-shape.${dataType}`,
        `${dataType} は linked=true、tracking=false、App Functionality として宣言する必要があります。`,
      ));
    }
  }
  const unexpected = declarations
    .map((item) => item.NSPrivacyCollectedDataType)
    .filter((dataType) => !expectedPrivacyDataTypes.includes(dataType));
  if (unexpected.length > 0) {
    failures.push(failure(
      "privacy.data.unexpected",
      `App Privacy source of truth にない data type があります: ${unexpected.join(", ")}`,
    ));
  }

  const accessed = Array.isArray(manifest.NSPrivacyAccessedAPITypes)
    ? manifest.NSPrivacyAccessedAPITypes
    : [];
  const reasonsByAPI = new Map(
    accessed.map((item) => [
      item.NSPrivacyAccessedAPIType,
      item.NSPrivacyAccessedAPITypeReasons,
    ]),
  );
  const userDefaultsReasons = reasonsByAPI.get("NSPrivacyAccessedAPICategoryUserDefaults");
  if (!Array.isArray(userDefaultsReasons) || !userDefaultsReasons.includes("CA92.1")) {
    failures.push(failure(
      "privacy.required-reason.user-defaults",
      "UserDefaults の Required Reason API 宣言に CA92.1 が必要です。",
    ));
  }
  const timestampReasons = reasonsByAPI.get("NSPrivacyAccessedAPICategoryFileTimestamp");
  if (!Array.isArray(timestampReasons) || !timestampReasons.includes("C617.1")) {
    failures.push(failure(
      "privacy.required-reason.file-timestamp",
      "File Timestamp の Required Reason API 宣言に C617.1 が必要です。",
    ));
  }
  return failures;
}

const sameDimension = (left, right) =>
  left.width === right.width && left.height === right.height;

export function verifyScreenshotManifest(manifest) {
  const failures = [];
  if (manifest.version !== 1) {
    failures.push(failure("screenshots.version", "screenshot manifest version は 1 が必要です。"));
  }
  if (manifest.locale !== "ja-JP") {
    failures.push(failure("screenshots.locale", "提出画像の locale は ja-JP が必要です。"));
  }
  if (manifest.display !== "6.9-inch") {
    failures.push(failure("screenshots.display", "提出画像は 6.9-inch 枠として宣言してください。"));
  }
  const dimensions = Array.isArray(manifest.acceptedPortraitDimensions)
    ? manifest.acceptedPortraitDimensions
    : [];
  for (const expected of expectedDimensions) {
    if (!dimensions.some((item) => sameDimension(item, expected))) {
      failures.push(failure(
        "screenshots.accepted-dimensions",
        `Apple accepted portrait dimension ${expected.width}x${expected.height} が manifest にありません。`,
      ));
    }
  }

  const screenshots = Array.isArray(manifest.screenshots) ? manifest.screenshots : [];
  if (screenshots.length < 3) {
    failures.push(failure(
      "screenshots.minimum-count",
      "6.9-inch 日本語スクリーンショットを最低 3 枚宣言する必要があります。",
    ));
  }
  const files = new Set();
  const scenes = new Set();
  const coverage = new Set();
  for (const [index, screenshot] of screenshots.entries()) {
    const label = `screenshots[${index}]`;
    if (typeof screenshot.file !== "string" || !/^[0-9]{2}-[a-z0-9-]+\.png$/.test(screenshot.file)) {
      failures.push(failure(`${label}.file`, `${label}.file は順序付き PNG 名が必要です。`));
    } else if (files.has(screenshot.file)) {
      failures.push(failure(`${label}.duplicate-file`, `${screenshot.file} が重複しています。`));
    } else {
      files.add(screenshot.file);
    }
    if (typeof screenshot.scene !== "string" || screenshot.scene.length === 0) {
      failures.push(failure(`${label}.scene`, `${label}.scene が必要です。`));
    } else if (scenes.has(screenshot.scene)) {
      failures.push(failure(`${label}.duplicate-scene`, `${screenshot.scene} scene が重複しています。`));
    } else {
      scenes.add(screenshot.scene);
    }
    if (screenshot.syntheticData !== true
        || screenshot.privateData !== false
        || screenshot.debugOverlay !== false) {
      failures.push(failure(
        `${label}.data-safety`,
        `${label} は syntheticData=true、privateData=false、debugOverlay=false が必要です。`,
      ));
    }
    if (typeof screenshot.accessibilityIdentifier !== "string"
        || !screenshot.accessibilityIdentifier.startsWith("app-store-screenshot-ready-")) {
      failures.push(failure(
        `${label}.accessibility-identifier`,
        `${label} に fixture ready identifier が必要です。`,
      ));
    }
    const content = screenshot.content && typeof screenshot.content === "object"
      ? screenshot.content
      : {};
    for (const [kind, value] of Object.entries(content)) {
      if (["video", "location", "transcript", "analysis"].includes(kind)
          && typeof value === "string"
          && value.trim().length >= 4) {
        coverage.add(kind);
      }
    }
  }
  const missingCoverage = ["video", "location", "transcript", "analysis"]
    .filter((kind) => !coverage.has(kind));
  if (missingCoverage.length > 0) {
    failures.push(failure(
      "screenshots.content-coverage",
      `合成 fixture の content coverage が不足しています: ${missingCoverage.join(", ")}`,
    ));
  }
  return failures;
}

export function readPngMetadata(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("PNG signature がありません");
  }
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG IHDR がありません");
  }

  let offset = 8;
  const idatChunks = [];
  let hasIHDR = false;
  let hasPLTE = false;
  let hasIDAT = false;
  let idatEnded = false;
  let hasIEND = false;
  const knownCriticalChunks = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new Error("PNG chunk が切断されています");
    }
    const dataLength = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataEnd = offset + 8 + dataLength;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) {
      throw new Error(`PNG ${type || "unknown"} chunk が切断されています`);
    }
    const expectedCRC = buffer.readUInt32BE(dataEnd);
    const actualCRC = crc32(buffer.subarray(offset + 4, dataEnd)) >>> 0;
    if (actualCRC !== expectedCRC) {
      throw new Error(`PNG ${type || "unknown"} chunk のCRCが不正です`);
    }
    if (/^[A-Z]/.test(type) && !knownCriticalChunks.has(type)) {
      throw new Error(`PNG の未知critical chunk ${type} は未対応です`);
    }
    if (type === "IHDR") {
      if (hasIHDR || offset !== 8 || dataLength !== 13) {
        throw new Error("PNG IHDR は先頭に1つだけ必要です");
      }
      hasIHDR = true;
    } else if (!hasIHDR) {
      throw new Error("PNG IHDR が先頭にありません");
    }
    if (type === "PLTE") {
      if (hasIDAT || dataLength === 0 || dataLength > 768 || dataLength % 3 !== 0) {
        throw new Error("PNG PLTE が不正です");
      }
      hasPLTE = true;
    }
    if (type === "tRNS") {
      throw new Error("PNG tRNS透明度はApp Store提出画像で使用できません");
    }
    if (type === "IDAT") {
      if (idatEnded) {
        throw new Error("PNG IDAT は連続している必要があります");
      }
      hasIDAT = true;
      idatChunks.push(buffer.subarray(offset + 8, dataEnd));
    } else if (hasIDAT && type !== "IEND") {
      idatEnded = true;
    }
    if (type === "IEND") {
      if (dataLength !== 0 || chunkEnd !== buffer.length) {
        throw new Error("PNG IEND が不正です");
      }
      if (!hasIDAT) {
        throw new Error("PNG IDAT がありません");
      }
      hasIEND = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!hasIEND) {
    throw new Error("PNG IEND がありません");
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  if (colorType === 3 && !hasPLTE) {
    throw new Error("PNG indexed-color image にPLTEがありません");
  }
  if ([0, 4].includes(colorType) && hasPLTE) {
    throw new Error("PNG grayscale image にPLTEは使用できません");
  }
  if (width === 0 || height === 0 || width > 10_000 || height > 10_000) {
    throw new Error("PNG dimensions が不正です");
  }
  if (buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] !== 0) {
    throw new Error("PNG compression/filter/interlace method は未対応です");
  }
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
  ]).get(colorType);
  if (bitDepth !== 8 || channels === undefined) {
    throw new Error("PNG は8-bitの対応color typeである必要があります");
  }
  const rowBytes = width * channels;
  const expectedDecodedBytes = height * (rowBytes + 1);
  if (expectedDecodedBytes > 128 * 1024 * 1024) {
    throw new Error("PNG decoded image が上限を超えています");
  }
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(idatChunks), {
      maxOutputLength: expectedDecodedBytes + 1,
    });
  } catch {
    throw new Error("PNG IDAT を展開できません");
  }
  if (decoded.length !== expectedDecodedBytes) {
    throw new Error("PNG IDAT のscanline長が不正です");
  }
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * (rowBytes + 1)] > 4) {
      throw new Error("PNG scanline filter が不正です");
    }
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
  };
}

function verifyScreenshotFiles(manifest, screenshotsDirectory) {
  const failures = [];
  for (const screenshot of manifest.screenshots ?? []) {
    const filePath = path.join(screenshotsDirectory, screenshot.file);
    if (!existsSync(filePath)) {
      failures.push(failure(
        `screenshots.artifact.${screenshot.file}`,
        `${screenshot.file} がありません。macOS の npm run screenshots:app-store で生成してください。`,
      ));
      continue;
    }
    let metadata;
    try {
      metadata = readPngMetadata(readFileSync(filePath));
    } catch (error) {
      failures.push(failure(
        `screenshots.png.${screenshot.file}`,
        `${screenshot.file} を検証できません: ${error.message}`,
      ));
      continue;
    }
    if (!expectedDimensions.some((item) => sameDimension(item, metadata))) {
      failures.push(failure(
        `screenshots.dimension.${screenshot.file}`,
        `${screenshot.file} は ${metadata.width}x${metadata.height} です。6.9-inch accepted portrait dimensions が必要です。`,
      ));
    }
    if (metadata.width >= metadata.height) {
      failures.push(failure(
        `screenshots.orientation.${screenshot.file}`,
        `${screenshot.file} は portrait である必要があります。`,
      ));
    }
    if ([4, 6].includes(metadata.colorType)) {
      failures.push(failure(
        `screenshots.alpha.${screenshot.file}`,
        `${screenshot.file} に alpha channel があります。App Store 提出 PNG は不透明にしてください。`,
      ));
    }
  }
  return failures;
}


function parseWorkflow(source) {
  const parsed = parseYaml(source, {
    maxAliasCount: 0,
    merge: false,
    uniqueKeys: true,
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow root must be a mapping");
  }
  return parsed;
}

function workflowHasTrigger(source, trigger) {
  let configured;
  try {
    configured = parseWorkflow(source).on;
  } catch {
    return false;
  }
  if (typeof configured === "string") return configured === trigger;
  if (Array.isArray(configured)) return configured.includes(trigger);
  return configured && typeof configured === "object"
    ? Object.hasOwn(configured, trigger)
    : false;
}

function topLevelPermissions(source) {
  let permissions;
  try {
    permissions = parseWorkflow(source).permissions;
  } catch {
    return [];
  }
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return [];
  }
  return Object.entries(permissions).map(([name, access]) => [name, String(access)]);
}

function extractJobBlock(source, jobName) {
  const jobs = extractYamlBlock(source, "jobs");
  const start = jobs.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) return [];
  const block = [];
  for (let index = start + 1; index < jobs.length; index += 1) {
    const line = jobs[index];
    if (line.trim() && leadingSpaces(line) <= 2) break;
    block.push(line);
  }
  return block;
}

function extractNamedStep(source, jobName, stepName) {
  const block = extractJobBlock(source, jobName);
  const start = block.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) return [];
  const indentation = leadingSpaces(block[start]);
  const result = [block[start]];
  for (let index = start + 1; index < block.length; index += 1) {
    const line = block[index];
    if (line.trim().startsWith("- ") && leadingSpaces(line) === indentation) break;
    result.push(line);
  }
  return result;
}

function extractJobs(source) {
  const jobs = parseWorkflow(source).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  return Object.entries(jobs)
    .filter(([, config]) => config && typeof config === "object" && !Array.isArray(config))
    .map(([name, config]) => ({ name, config }));
}

const expectedRunnerLabels = ["self-hosted", "macOS", "ARM64", "afterimage-ci"];

export function verifyWorkflowTrust(workflows) {
  const failures = [];
  for (const workflow of workflows) {
    let jobs;
    try {
      jobs = extractJobs(workflow.content);
    } catch (error) {
      failures.push(failure(
        "ci.workflow-yaml",
        `${workflow.path} を安全にYAML解析できません: ${error.message}`,
      ));
      continue;
    }

    if (workflowHasTrigger(workflow.content, "pull_request_target")) {
      failures.push(failure(
        "ci.pull-request-target",
        `${workflow.path} は privileged pull_request_target を使用できません。`,
      ));
    }
    if (workflowHasTrigger(workflow.content, "pull_request")) {
      failures.push(failure(
        "ci.pr.trigger",
        `${workflow.path} はpull_requestから直接・reusable経由のjobを実行できません。trusted branch pushで検証してください。`,
      ));
    }

    for (const job of jobs) {
      if (Object.hasOwn(job.config, "runs-on")) {
        const runner = job.config["runs-on"];
        if (!Array.isArray(runner)
            || runner.length !== expectedRunnerLabels.length
            || !runner.every((label, index) => label === expectedRunnerLabels[index])) {
          failures.push(failure(
            "ci.runner-labels",
            `${workflow.path} のjob ${job.name}は runs-on: ${expectedRunner} を使用する必要があります。`,
          ));
        }
      }

      const actionReferences = [];
      if (typeof job.config.uses === "string") actionReferences.push(job.config.uses);
      for (const step of Array.isArray(job.config.steps) ? job.config.steps : []) {
        if (step && typeof step === "object" && typeof step.uses === "string") {
          actionReferences.push(step.uses);
        }
      }
      for (const action of actionReferences) {
        if (action.startsWith("./")) continue;
        const reference = action.split("@")[1] ?? "";
        if (!/^[0-9a-f]{40}$/i.test(reference)) {
          failures.push(failure(
            "ci.action-pin",
            `${workflow.path} の ${action} は full commit SHA で pin してください。`,
          ));
        }
      }
    }

    const pullRequestTrigger = ["pull_request", "pull_request_target"]
      .find((trigger) => workflowHasTrigger(workflow.content, trigger));
    if (!pullRequestTrigger) continue;
    if (jobs.some((job) => Object.hasOwn(job.config, "runs-on"))) {
      failures.push(failure(
        "ci.pr.self-hosted",
        `${workflow.path} は ${pullRequestTrigger} からself-hosted runnerを実行できません。trusted repository branchのpushで検証してください。`,
      ));
    }
    const permissions = topLevelPermissions(workflow.content);
    if (permissions.length !== 1
        || permissions[0][0] !== "contents"
        || permissions[0][1] !== "read") {
      failures.push(failure(
        "ci.pr.permissions",
        `${workflow.path} の PR workflow は top-level permissions を contents: read のみにしてください。`,
      ));
    }
    if (workflow.content.includes("${{ secrets.")) {
      failures.push(failure(
        "ci.pr.secrets",
        `${workflow.path} の PR job は secrets を参照できません。`,
      ));
    }
    const commands = jobs.flatMap((job) =>
      (Array.isArray(job.config.steps) ? job.config.steps : [])
        .flatMap((step) =>
          step && typeof step === "object" && typeof step.run === "string"
            ? normalizedLines(step.run).map((line) => line.trim()).filter(Boolean)
            : []
        )
    );
    const forbidden = commands.find((command) =>
      /^(?:sudo\b|brew\s+(?:install|upgrade|uninstall|tap|untap)\b|security\s+(?:unlock-keychain|default-keychain|list-keychains)\b|rm\s+-rf\b|git\s+(?:clean|reset)\b)/.test(command)
    );
    if (forbidden) {
      failures.push(failure(
        "ci.pr.runner-mutation",
        `${workflow.path} の PR job に self-hosted runner mutation があります: ${forbidden}`,
      ));
    }
  }
  return failures;
}

export function verifyBackendWorkflow(source) {
  const failures = [];
  let workflow;
  try {
    workflow = parseWorkflow(source);
  } catch (error) {
    failures.push(failure(
      "ci.backend-yaml",
      `backend workflowを安全にYAML解析できません: ${error.message}`,
    ));
    return failures;
  }

  const push = workflow.on && typeof workflow.on === "object"
    ? workflow.on.push
    : undefined;
  const branches = push && typeof push === "object" ? push.branches : undefined;
  const branchList = Array.isArray(branches) ? branches : branches ? [branches] : [];
  if (!branchList.includes("main") && !branchList.includes("**")) {
    failures.push(failure(
      "ci.backend.trigger",
      "backend workflowはmainへのpushをtriggerに含める必要があります。",
    ));
  }

  const jobs = workflow.jobs && typeof workflow.jobs === "object"
    ? workflow.jobs
    : {};
  const deploy = jobs.deploy;
  if (!deploy || typeof deploy !== "object" || Array.isArray(deploy)) {
    failures.push(failure(
      "ci.backend.deploy-job",
      "backend workflowにdeploy jobが必要です。",
    ));
    return failures;
  }

  const needs = Array.isArray(deploy.needs) ? deploy.needs : [deploy.needs];
  if (!needs.includes("check")) {
    failures.push(failure(
      "ci.backend.needs",
      "production deploy jobはcheck jobの成功後に実行してください。",
    ));
  }

  const condition = String(deploy.if ?? "");
  if (!condition.includes("github.ref == 'refs/heads/main'")
      || !condition.includes("github.event_name == 'push'")
      || !condition.includes("github.event_name == 'workflow_dispatch'")) {
    failures.push(failure(
      "ci.backend.main-gate",
      "production deployはmainのtrusted pushまたはworkflow_dispatchだけに制限してください。",
    ));
  }

  const steps = Array.isArray(deploy.steps) ? deploy.steps : [];
  const shell = steps
    .map((step) => step && typeof step.run === "string" ? step.run : "")
    .join("\n");
  if (!source.includes("${{ secrets.CLOUDFLARE_API_TOKEN }}")) {
    failures.push(failure(
      "ci.backend.cloudflare-auth",
      "production deployにはCLOUDFLARE_API_TOKEN secretを明示的に渡してください。",
    ));
  }
  if (!source.includes("${{ secrets.AFTERIMAGE_PRODUCTION_WRANGLER_CONFIG }}")) {
    failures.push(failure(
      "ci.backend.wrangler-config",
      "production deployにはAFTERIMAGE_PRODUCTION_WRANGLER_CONFIG secretが必要です。",
    ));
  }
  const deployIndex = shell.indexOf("scripts/deploy-backend-production.sh");
  if (deployIndex < 0) {
    failures.push(failure(
      "ci.backend.script",
      "repo管理のscripts/deploy-backend-production.shをproduction deployで使ってください。",
    ));
  }
  if (!shell.includes("backend/wrangler.jsonc")
      || !shell.includes("trap")
      || !shell.includes("rm -f backend/wrangler.jsonc")) {
    failures.push(failure(
      "ci.backend.config-cleanup",
      "一時的なproduction Wrangler configはdeploy後に必ず削除してください。",
    ));
  }
  return failures;
}

export function verifyBackendRolloutScript(source) {
  const failures = [];
  const executable = normalizedLines(source)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
  const maintenanceProbe = executable.indexOf("expect_status 503");
  const maintenance = executable.lastIndexOf(
    "wrangler deploy src/maintenance.ts",
    maintenanceProbe,
  );
  const migration = executable.indexOf("wrangler d1 migrations apply");
  const finalDeploy = executable.lastIndexOf('wrangler deploy --config "$WRANGLER_CONFIG"');
  const finalProbe = executable.indexOf("expect_status 200");
  const appleCredentialChecks = [
    executable.indexOf("wrangler secret list"),
    executable.indexOf("APPLE_TEAM_ID"),
    executable.indexOf("APPLE_KEY_ID"),
    executable.indexOf("APPLE_PRIVATE_KEY"),
  ];
  if (maintenance < 0 || appleCredentialChecks.some((index) =>
    index < 0 || index >= maintenance
  )) {
    failures.push(failure(
      "backend.rollout.apple-credentials",
      "maintenance移行前にAPPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEYをpreflightしてください。",
    ));
  }
  if (maintenance < 0
      || maintenanceProbe <= maintenance
      || migration <= maintenanceProbe
      || finalDeploy <= migration
      || finalProbe <= finalDeploy) {
    failures.push(failure(
      "backend.rollout.order",
      "production backendはmaintenance deploy→503確認→D1 migration→final deploy→200確認の順で適用してください。",
    ));
  }
  return failures;
}

export function verifyDeployWorkflow(source) {
  const failures = [];
  let deploySteps = [];
  try {
    const parsed = parseWorkflow(source);
    const configuredSteps = parsed.jobs?.deploy?.steps;
    deploySteps = Array.isArray(configuredSteps) ? configuredSteps : [];
  } catch (error) {
    failures.push(failure(
      "ci.deploy-yaml",
      `ios-deploy.ymlを安全にYAML解析できません: ${error.message}`,
    ));
    return failures;
  }
  const parsedStepIndex = (name) => deploySteps.findIndex((step) =>
    step && typeof step === "object" && step.name === name
  );
  const parsedStep = (name) => {
    const index = parsedStepIndex(name);
    return index >= 0 ? deploySteps[index] : undefined;
  };
  const executableShell = (step) => typeof step?.run === "string"
    ? normalizedLines(step.run)
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter((line) => line && !line.startsWith("#"))
      .join("\n")
    : "";
  if (workflowHasTrigger(source, "pull_request")
      || workflowHasTrigger(source, "pull_request_target")) {
    failures.push(failure(
      "ci.deploy-trigger",
      "ios-deploy.yml は pull request から実行できないようにしてください。",
    ));
  }
  const deployJob = extractJobBlock(source, "deploy");
  if (!deployJob.some((line) =>
    line.trim() === "if: github.ref == 'refs/heads/main'"
  )) {
    failures.push(failure(
      "ci.deploy-main-only",
      "TestFlight deploy job は refs/heads/main に限定してください。",
    ));
  }
  const preflight = extractNamedStep(source, "deploy", "Preflight App Store Connect secrets");
  for (const secret of [
    "AFTERIMAGE_CI_KEYCHAIN_PASSWORD",
    "ASC_ISSUER_ID",
    "ASC_KEY_ID",
    "ASC_PRIVATE_KEY",
  ]) {
    if (!preflight.some((line) => line.includes(`${secret}: \${{ secrets.${secret} }}`))
        || !preflight.some((line) => line.includes(`-z "$${secret}"`))) {
      failures.push(failure(
        `ci.deploy-secret.${secret}`,
        `TestFlight preflight は ${secret} の存在を値を表示せず検証する必要があります。`,
      ));
    }
  }
  const keyCleanup = extractNamedStep(
    source,
    "deploy",
    "Remove temporary App Store Connect API key",
  );
  if (!keyCleanup.some((line) => line.trim() === "if: always()")) {
    failures.push(failure(
      "ci.asc-key-cleanup",
      "一時 ASC key の cleanup step は if: always() が必要です。",
    ));
  }
  const keychainCleanup = extractNamedStep(
    source,
    "deploy",
    "Remove temporary signing keychain",
  );
  if (!keychainCleanup.some((line) => line.trim() === "if: always()")) {
    failures.push(failure(
      "ci.keychain-cleanup",
      "一時 signing keychain の cleanup step は if: always() が必要です。",
    ));
  }
  const keychainSetup = extractNamedStep(
    source,
    "deploy",
    "Configure temporary signing keychain",
  );
  if (!keychainSetup.some((line) => line.includes("$RUNNER_TEMP/afterimage-signing."))) {
    failures.push(failure(
      "ci.temporary-keychain",
      "signing keychain は RUNNER_TEMP 配下の job-local copy を使用してください。",
    ));
  }
  const archiveStep = parsedStep("Archive");
  const archiveReadback = parsedStep("Verify archived app before export");
  const exportStep = parsedStep("Export and upload to TestFlight");
  const archiveCommand = executableShell(archiveStep);
  const readbackCommand = executableShell(archiveReadback);
  const exportCommand = executableShell(exportStep);
  const requiredReadbackFragments = [
    "python3 scripts/verify-ios-archive.py",
    "--archive ios/build/afterimage.xcarchive",
    "--expected-commit \"$GITHUB_SHA\"",
    "--expected-build \"$GITHUB_RUN_NUMBER\"",
    "--expected-privacy-manifest ios/Resources/PrivacyInfo.xcprivacy",
    "--report ios/ArchiveEvidence.json",
  ];
  const archiveIndex = parsedStepIndex("Archive");
  const readbackIndex = parsedStepIndex("Verify archived app before export");
  const exportIndex = parsedStepIndex("Export and upload to TestFlight");
  if (!archiveStep || !archiveReadback || !exportStep
      || Object.hasOwn(archiveStep, "if")
      || Object.hasOwn(archiveReadback, "if")
      || Object.hasOwn(exportStep, "if")
      || !archiveCommand.includes("xcodebuild archive")
      || !archiveCommand.includes('AFTERIMAGE_BUILD_COMMIT="$GITHUB_SHA"')
      || requiredReadbackFragments.some((fragment) => !readbackCommand.includes(fragment))
      || !exportCommand.includes("xcodebuild -exportArchive")
      || archiveIndex < 0 || readbackIndex <= archiveIndex || exportIndex <= readbackIndex) {
    failures.push(failure(
      "ci.deploy.archive-readback",
      "TestFlight export前に有効なarchiveのdevice family、privacy manifest、version、build、commitをread-backしてください。",
    ));
  }
  const releaseEvidenceUpload = extractNamedStep(
    source,
    "deploy",
    "Upload release evidence",
  );
  if (!releaseEvidenceUpload.some((line) => line.includes("ios/ArchiveEvidence.json"))) {
    failures.push(failure(
      "ci.deploy.archive-evidence-upload",
      "archive read-backの構造化evidenceをrelease artifactへ含めてください。",
    ));
  }
  return failures;
}

function readJSON(root, relative, failures, id) {
  const filePath = path.join(root, relative);
  if (!existsSync(filePath)) {
    failures.push(failure(id, `${relative} がありません。`));
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    failures.push(failure(id, `${relative} を解析できません: ${error.message}`));
    return null;
  }
}

function verifyMetadata(metadata, root) {
  const failures = [];
  if (!metadata) return failures;
  if (metadata.version !== 1 || metadata.locale !== "ja-JP") {
    failures.push(failure(
      "metadata.identity",
      "release-metadata.json は version=1、locale=ja-JP が必要です。",
    ));
  }
  if (metadata.appName !== "afterimage"
      || typeof metadata.subtitle !== "string"
      || metadata.subtitle.length === 0
      || metadata.subtitle.length > 30) {
    failures.push(failure(
      "metadata.name",
      "appName=afterimage と30文字以内の日本語subtitleが必要です。",
    ));
  }
  if (typeof metadata.description !== "string" || metadata.description.trim().length < 300) {
    failures.push(failure(
      "metadata.description",
      "日本語 description は 300 文字以上の完成稿が必要です。",
    ));
  } else if (metadata.description.length > 4_000) {
    failures.push(failure(
      "metadata.description-limit",
      "日本語 description は 4,000 文字以内にしてください。",
    ));
  }
  const keywords = Array.isArray(metadata.keywords) ? metadata.keywords : [];
  if (keywords.length < 5 || keywords.join(",").length > 100) {
    failures.push(failure(
      "metadata.keywords",
      "keywords は 5 件以上、カンマ込み 100 文字以内で指定してください。",
    ));
  }
  if (metadata.categories?.primary !== "PHOTO_AND_VIDEO"
      || metadata.categories?.secondary !== "LIFESTYLE") {
    failures.push(failure(
      "metadata.categories",
      "カテゴリ推奨は primary=PHOTO_AND_VIDEO、secondary=LIFESTYLE が必要です。",
    ));
  }
  for (const [kind, url] of Object.entries(expectedLegalURLs)) {
    if (metadata.legalURLs?.[kind] !== url) {
      failures.push(failure(
        `metadata.url.${kind}`,
        `${kind} URL は ${url} を source of truth としてください。`,
      ));
    }
  }
  const ageRating = metadata.ageRating;
  if (!ageRating || ageRating.questionnaireVersion !== "ios26"
      || !ageRating.inAppControls || !ageRating.capabilities
      || !ageRating.contentDescriptors || !ageRating.rationale) {
    failures.push(failure(
      "metadata.age-rating",
      "iOS 26 用 age-rating answers と rationale が不足しています。",
    ));
  }
  const privacyTypes = new Set(
    (metadata.appPrivacy?.dataTypes ?? []).map((item) => item.manifestType),
  );
  for (const dataType of expectedPrivacyDataTypes) {
    if (!privacyTypes.has(dataType)) {
      failures.push(failure(
        `metadata.app-privacy.${dataType}`,
        `App Privacy answers に ${dataType} がありません。`,
      ));
    }
  }
  if (privacyTypes.size !== (metadata.appPrivacy?.dataTypes ?? []).length
      || privacyTypes.size !== expectedPrivacyDataTypes.length) {
    failures.push(failure(
      "metadata.app-privacy-set",
      "App Privacy data typeはmanifestと同じ重複なしの集合にしてください。",
    ));
  }
  for (const item of metadata.appPrivacy?.dataTypes ?? []) {
    if (item.purpose !== "APP_FUNCTIONALITY"
        || typeof item.use !== "string"
        || item.use.trim().length < 20
        || !Array.isArray(item.evidence)
        || item.evidence.length === 0) {
      failures.push(failure(
        `metadata.app-privacy-evidence.${item.manifestType}`,
        `${item.manifestType} にpurpose、利用説明、code evidenceが必要です。`,
      ));
      continue;
    }
    for (const evidencePath of item.evidence) {
      if (!existsSync(path.join(root, evidencePath))) {
        failures.push(failure(
          `metadata.app-privacy-path.${item.manifestType}`,
          `${item.manifestType} のcode evidenceが存在しません: ${evidencePath}`,
        ));
      }
    }
  }
  if (metadata.appPrivacy?.tracking !== false
      || metadata.appPrivacy?.dataLinkedToUser !== true) {
    failures.push(failure(
      "metadata.app-privacy-shape",
      "App Privacy は tracking=false、dataLinkedToUser=true が必要です。",
    ));
  }
  const processors = new Set(
    (metadata.appPrivacy?.processors ?? []).map((processor) => processor.name),
  );
  for (const processor of ["Cloudflare", "Soniox", "Alibaba Cloud Qwen", "MCP client or agent"]) {
    if (!processors.has(processor)) {
      failures.push(failure(
        `metadata.processor.${processor}`,
        `App Privacy processor disclosure に ${processor} がありません。`,
      ));
    }
  }
  const prerequisites = new Set(metadata.submissionPrerequisites ?? []);
  for (const id of [
    "AUTH_CHALLENGE",
    "ACCOUNT_DELETION",
    "AI_CONSENT",
    "LEGAL_PRIVACY",
    "LEGAL_SUPPORT",
    "LEGAL_TERMS",
    "REAL_DEVICE_SMOKE",
    "SCREENSHOTS_69",
    "ARCHIVE_EXPORT",
  ]) {
    if (!prerequisites.has(id)) {
      failures.push(failure(
        `metadata.submission-prerequisite.${id}`,
        `submissionPrerequisites に ${id} がありません。`,
      ));
    }
  }
  const documents = [
    "docs/app-store/README.md",
    "docs/app-store/metadata-ja.md",
    "docs/app-store/app-privacy.md",
    "docs/app-store/review-notes-ja.md",
    "docs/app-store/release-runbook.md",
    "docs/app-store/release-checklist.md",
    "docs/app-store/screenshots/README.md",
  ];
  for (const document of documents) {
    const filePath = path.join(root, document);
    if (!existsSync(filePath) || readFileSync(filePath, "utf8").trim().length < 200) {
      failures.push(failure(
        `metadata.document.${document}`,
        `${document} は 200 文字以上の提出資料として必要です。`,
      ));
    }
  }
  const reviewPath = path.join(root, "docs/app-store/review-notes-ja.md");
  if (existsSync(reviewPath)) {
    const reviewNotes = readFileSync(reviewPath, "utf8");
    for (const marker of [
      "Sign in with Apple",
      "カメラ",
      "マイク",
      "写真",
      "位置情報",
      "AI同意",
      "アカウント削除",
      "審査手順",
    ]) {
      if (!reviewNotes.includes(marker)) {
        failures.push(failure(
          `metadata.review-notes.${marker}`,
          `review notes に ${marker} の説明がありません。`,
        ));
      }
    }
  }
  return failures;
}

export function verifyEvidence(evidence, mode) {
  const failures = [];
  if (!evidence) return failures;
  const commitPattern = /^[0-9a-f]{40}$/;
  const sha256Pattern = /^[0-9a-f]{64}$/;
  const evidenceTypes = new Set([
    "github_actions",
    "artifact",
    "live_probe",
    "app_store_connect",
    "human_review",
  ]);
  const releaseCommit = typeof evidence.releaseCommit === "string"
    ? evidence.releaseCommit
    : "";
  if ((releaseCommit || mode === "submission") && !commitPattern.test(releaseCommit)) {
    failures.push(failure(
      "evidence.release-commit",
      "release-evidence.json の releaseCommit は対象buildの40桁commit SHAである必要があります。",
    ));
  }
  const entries = Array.isArray(evidence.entries) ? evidence.entries : [];
  const byID = new Map(entries.map((entry) => [entry.id, entry]));
  for (const id of expectedEvidenceIDs) {
    const entry = byID.get(id);
    if (!entry) {
      failures.push(failure(
        `evidence.${id}`,
        `release-evidence.json に ${id} marker がありません。`,
      ));
      continue;
    }
    if (entry.requiredForSubmission !== true
        || !["pending", "verified", "blocked"].includes(entry.status)
        || typeof entry.instructions !== "string"
        || entry.instructions.trim().length < 12
        || !Array.isArray(entry.evidence)) {
      failures.push(failure(
        `evidence.${id}.shape`,
        `${id} は required/status/instructions/evidence fields を持つ必要があります。`,
      ));
    }
    const evidenceItems = Array.isArray(entry.evidence) ? entry.evidence : [];
    evidenceItems.forEach((item, index) => {
      const itemID = `evidence.${id}.item.${index}`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        failures.push(failure(
          itemID,
          `${id} evidence ${index + 1} は構造化された実測証跡である必要があります。`,
        ));
        return;
      }
      if (!evidenceTypes.has(item.type)
          || item.result !== "passed"
          || typeof item.recordedAt !== "string"
          || !Number.isFinite(Date.parse(item.recordedAt))
          || typeof item.url !== "string"
          || typeof item.details !== "string"
          || item.details.trim().length < 12) {
        failures.push(failure(
          `${itemID}.shape`,
          `${id} evidence ${index + 1} はtype/result/recordedAt/url/detailsを満たす必要があります。`,
        ));
      }
      let evidenceURL;
      try {
        evidenceURL = new URL(item.url);
      } catch {
        evidenceURL = undefined;
      }
      if (evidenceURL?.protocol !== "https:") {
        failures.push(failure(
          `${itemID}.url`,
          `${id} evidence ${index + 1} はHTTPS証跡URLが必要です。`,
        ));
      }
      const canonicalRunURL = Number.isSafeInteger(item.runId) && item.runId > 0
        ? `https://github.com/kandotrun/afterimage-app/actions/runs/${item.runId}`
        : "";
      if (!Number.isSafeInteger(item.runId) || item.runId <= 0
          || !Number.isSafeInteger(item.runAttempt) || item.runAttempt <= 0
          || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(item.workflowPath ?? "")
          || typeof item.jobName !== "string" || item.jobName.trim().length === 0
          || item.url !== canonicalRunURL) {
        failures.push(failure(
          `${itemID}.provenance`,
          `${id} evidence ${index + 1} はcanonical GitHub run URLとrunId/runAttempt/workflowPath/jobNameが必要です。`,
        ));
      }
      const allowedProducers = evidencePolicies[id] ?? [];
      if (!allowedProducers.some(([workflowPath, jobName]) =>
        item.workflowPath === workflowPath && item.jobName === jobName
      )) {
        failures.push(failure(
          `${itemID}.policy`,
          `${id} evidence ${index + 1} は要件に対応する承認済みworkflow/jobから生成されていません。`,
        ));
      }
      if (!commitPattern.test(item.commit ?? "")
          || (commitPattern.test(releaseCommit) && item.commit !== releaseCommit)) {
        failures.push(failure(
          `${itemID}.commit`,
          `${id} evidence ${index + 1} はreleaseCommitと同じcommit SHAへbindする必要があります。`,
        ));
      }
      if (item.type === "artifact"
          && (!sha256Pattern.test(item.sha256 ?? "")
            || !Number.isSafeInteger(item.artifactId)
            || item.artifactId <= 0)) {
        failures.push(failure(
          `${itemID}.sha256`,
          `${id} artifact evidence ${index + 1} はSHA-256とartifactIdが必要です。`,
        ));
      }
    });
    if (mode === "submission"
        && (entry.status !== "verified" || evidenceItems.length === 0)) {
      failures.push(failure(
        `submission.${id}`,
        `${id} は未検証です。status=verified と実測 evidence を記録するまで提出できません。`,
      ));
    }
  }
  const unexpected = entries.map((entry) => entry.id)
    .filter((id) => !expectedEvidenceIDs.includes(id));
  if (unexpected.length > 0) {
    failures.push(failure(
      "evidence.unexpected",
      `未知の release evidence marker があります: ${unexpected.join(", ")}`,
    ));
  }
  return failures;
}

async function fetchGitHubJSON(url, { fetchImpl, token }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new Error(`GitHub API request failed: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function verifyEvidenceProvenance(evidence, {
  fetchImpl = fetch,
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
} = {}) {
  const failures = [];
  const releaseCommit = evidence?.releaseCommit;
  for (const entry of Array.isArray(evidence?.entries) ? evidence.entries : []) {
    if (entry?.status !== "verified") continue;
    const items = Array.isArray(entry.evidence) ? entry.evidence : [];
    for (const [index, item] of items.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const baseID = `provenance.${entry.id}.${index}`;
      if (!Number.isSafeInteger(item.runId) || item.runId <= 0
          || !Number.isSafeInteger(item.runAttempt) || item.runAttempt <= 0
          || typeof item.workflowPath !== "string" || !item.workflowPath.startsWith(".github/workflows/")
          || typeof item.jobName !== "string" || item.jobName.trim().length === 0) {
        failures.push(failure(
          `${baseID}.shape`,
          `${entry.id} evidence ${index + 1} にrunId/runAttempt/workflowPath/jobNameが必要です。`,
        ));
        continue;
      }
      const runURL = `https://api.github.com/repos/kandotrun/afterimage-app/actions/runs/${item.runId}`;
      let run;
      try {
        run = await fetchGitHubJSON(runURL, { fetchImpl, token });
      } catch (error) {
        failures.push(failure(`${baseID}.run.fetch`, error.message));
        continue;
      }
      const expectedWebURL = `https://github.com/kandotrun/afterimage-app/actions/runs/${item.runId}`;
      const runPath = String(run.path ?? "").split("@")[0];
      for (const [suffix, condition, message] of [
        ["repository", run.repository?.full_name === "kandotrun/afterimage-app", "repositoryが一致しません。"],
        ["id", run.id === item.runId, "run IDが一致しません。"],
        ["commit", run.head_sha === releaseCommit && run.head_sha === item.commit, "run commitがreleaseCommitと一致しません。"],
        ["attempt", run.run_attempt === item.runAttempt, "run attemptが一致しません。"],
        ["workflow", runPath === item.workflowPath, "workflow pathが一致しません。"],
        ["result", run.status === "completed" && run.conclusion === "success", "runが成功完了していません。"],
        ["event", ["push", "workflow_dispatch"].includes(run.event), "runはtrusted pushまたはworkflow_dispatchである必要があります。"],
        ["url", run.html_url === expectedWebURL && item.url === expectedWebURL, "run URLがcanonical URLと一致しません。"],
      ]) {
        if (!condition) failures.push(failure(`${baseID}.run.${suffix}`, message));
      }

      const jobsURL = `${runURL}/jobs?per_page=100`;
      let jobs;
      try {
        jobs = await fetchGitHubJSON(jobsURL, { fetchImpl, token });
      } catch (error) {
        failures.push(failure(`${baseID}.job.fetch`, error.message));
        continue;
      }
      const job = Array.isArray(jobs.jobs)
        ? jobs.jobs.find((candidate) => candidate.name === item.jobName)
        : undefined;
      if (!job) {
        failures.push(failure(
          `${baseID}.job.missing`,
          `成功証跡job ${item.jobName} がrunにありません。`,
        ));
      } else {
        if (job.status !== "completed" || job.conclusion !== "success") {
          failures.push(failure(`${baseID}.job.result`, "証跡jobが成功完了していません。"));
        }
        if (job.head_sha && job.head_sha !== releaseCommit) {
          failures.push(failure(`${baseID}.job.commit`, "証跡jobのcommitが一致しません。"));
        }
      }

      if (item.type === "artifact") {
        if (!Number.isSafeInteger(item.artifactId) || item.artifactId <= 0) {
          failures.push(failure(`${baseID}.artifact.shape`, "artifactIdが必要です。"));
          continue;
        }
        let artifact;
        try {
          artifact = await fetchGitHubJSON(
            `https://api.github.com/repos/kandotrun/afterimage-app/actions/artifacts/${item.artifactId}`,
            { fetchImpl, token },
          );
        } catch (error) {
          failures.push(failure(`${baseID}.artifact.fetch`, error.message));
          continue;
        }
        if (artifact.expired !== false
            || artifact.workflow_run?.id !== item.runId
            || artifact.workflow_run?.head_sha !== releaseCommit
            || artifact.digest !== `sha256:${item.sha256}`) {
          failures.push(failure(
            `${baseID}.artifact.provenance`,
            "artifactが対象run/commit/SHA-256へbindされていないか期限切れです。",
          ));
        }
      }
    }
  }
  return failures;
}

function verifySourceContracts(root) {
  const failures = [];
  const requirements = [
    {
      id: "source.screenshot-fixture",
      file: "ios/Sources/Features/AppStore/AppStoreScreenshotFixtureView.swift",
      markers: [
        "AppStoreScreenshotScene",
        "app-store-screenshot-ready-",
        "synthetic",
      ],
    },
    {
      id: "source.screenshot-ui-test",
      file: "ios/UITests/AppStoreScreenshotUITests.swift",
      markers: [
        "AFTERIMAGE_SCREENSHOT_OUTPUT_DIR",
        "XCUIScreen.main.screenshot()",
        "opaquePNGData",
      ],
    },
    {
      id: "source.screenshot-automation",
      file: "scripts/generate-app-store-screenshots.sh",
      markers: [
        "iPhone 16 Pro Max",
        "AppStoreScreenshotUITests",
        "--mode screenshots",
      ],
    },
  ];
  for (const requirement of requirements) {
    const filePath = path.join(root, requirement.file);
    if (!existsSync(filePath)) {
      failures.push(failure(requirement.id, `${requirement.file} がありません。`));
      continue;
    }
    const content = readFileSync(filePath, "utf8");
    for (const marker of requirement.markers) {
      if (!content.includes(marker)) {
        failures.push(failure(
          `${requirement.id}.${marker}`,
          `${requirement.file} に ${marker} contract がありません。`,
        ));
      }
    }
  }
  return failures;
}

export function verifyRepository({
  root = scriptRoot,
  mode = "contracts",
  screenshotsDirectory,
} = {}) {
  if (!["contracts", "screenshots", "submission"].includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  const failures = [];
  const projectPath = path.join(root, "ios/project.yml");
  const privacyPath = path.join(root, "ios/Resources/PrivacyInfo.xcprivacy");
  if (existsSync(projectPath)) {
    failures.push(...verifyTargetFamilies(readFileSync(projectPath, "utf8")));
  } else {
    failures.push(failure("target.project", "ios/project.yml がありません。"));
  }
  if (existsSync(privacyPath)) {
    failures.push(...verifyPrivacyManifest(readFileSync(privacyPath, "utf8")));
  } else {
    failures.push(failure("privacy.file", "ios/Resources/PrivacyInfo.xcprivacy がありません。"));
  }

  const metadata = readJSON(
    root,
    "docs/app-store/release-metadata.json",
    failures,
    "metadata.file",
  );
  failures.push(...verifyMetadata(metadata, root));
  const evidence = readJSON(
    root,
    "docs/app-store/release-evidence.json",
    failures,
    "evidence.file",
  );
  failures.push(...verifyEvidence(evidence, mode));
  const screenshotManifest = readJSON(
    root,
    "docs/app-store/screenshots/manifest.json",
    failures,
    "screenshots.manifest",
  );
  if (screenshotManifest) {
    failures.push(...verifyScreenshotManifest(screenshotManifest));
  }
  failures.push(...verifySourceContracts(root));

  const backendRolloutPath = path.join(root, "scripts/deploy-backend-production.sh");
  if (!existsSync(backendRolloutPath)) {
    failures.push(failure(
      "backend.rollout-file",
      "scripts/deploy-backend-production.sh がありません。",
    ));
  } else {
    failures.push(...verifyBackendRolloutScript(
      readFileSync(backendRolloutPath, "utf8"),
    ));
  }

  const workflowRoot = path.join(root, ".github/workflows");
  const workflows = existsSync(workflowRoot)
    ? readdirSync(workflowRoot)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort()
      .map((name) => ({
        path: `.github/workflows/${name}`,
        content: readFileSync(path.join(workflowRoot, name), "utf8"),
      }))
    : [];
  failures.push(...verifyWorkflowTrust(workflows));
  const deploy = workflows.find((workflow) => workflow.path.endsWith("/ios-deploy.yml"));
  if (!deploy) {
    failures.push(failure("ci.deploy-file", ".github/workflows/ios-deploy.yml がありません。"));
  } else {
    failures.push(...verifyDeployWorkflow(deploy.content));
  }
  const backendWorkflow = workflows.find((workflow) =>
    workflow.path.endsWith("/backend.yml")
  );
  if (!backendWorkflow) {
    failures.push(failure(
      "ci.backend-file",
      ".github/workflows/backend.yml がありません。",
    ));
  } else {
    failures.push(...verifyBackendWorkflow(backendWorkflow.content));
  }
  const screenshotWorkflow = workflows.find((workflow) =>
    workflow.path.endsWith("/app-store-screenshots.yml")
  );
  if (!screenshotWorkflow) {
    failures.push(failure(
      "ci.screenshot-workflow",
      ".github/workflows/app-store-screenshots.yml がありません。",
    ));
  } else if (!workflowHasTrigger(screenshotWorkflow.content, "workflow_dispatch")) {
    failures.push(failure(
      "ci.screenshot-trigger",
      "app-store-screenshots.yml は明示的な workflow_dispatch が必要です。",
    ));
  }

  if ((mode === "screenshots" || mode === "submission") && screenshotManifest) {
    const directory = screenshotsDirectory
      ? path.resolve(root, screenshotsDirectory)
      : path.join(root, "artifacts/app-store/screenshots");
    failures.push(...verifyScreenshotFiles(screenshotManifest, directory));
  }
  return failures;
}

function parseArguments(argv) {
  const options = {
    root: scriptRoot,
    mode: "contracts",
    screenshotsDirectory: undefined,
    report: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [key, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (key === "--mode") {
      options.mode = value;
      if (inlineValue === undefined) index += 1;
    } else if (key === "--root") {
      options.root = path.resolve(value);
      if (inlineValue === undefined) index += 1;
    } else if (key === "--screenshots-dir") {
      options.screenshotsDirectory = value;
      if (inlineValue === undefined) index += 1;
    } else if (key === "--report") {
      options.report = path.resolve(value);
      if (inlineValue === undefined) index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function runCLI() {
  const options = parseArguments(process.argv.slice(2));
  const failures = verifyRepository(options);
  if (options.mode === "submission") {
    const evidencePath = path.join(options.root, "docs/app-store/release-evidence.json");
    if (existsSync(evidencePath)) {
      let evidence;
      try {
        evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      } catch {
        failures.push(failure(
          "provenance.evidence-file",
          "remote provenance検証用のrelease-evidence.jsonを読めません。",
        ));
      }
      if (evidence) failures.push(...await verifyEvidenceProvenance(evidence));
    }
  }
  const report = {
    verifier: "afterimage-app-store",
    version: 1,
    mode: options.mode,
    checkedAt: new Date().toISOString(),
    status: failures.length === 0 ? "passed" : "failed",
    failures,
  };
  if (options.report) {
    mkdirSync(path.dirname(options.report), { recursive: true });
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failures.length > 0) {
    process.stderr.write(`App Store ${options.mode} verification failed (${failures.length})\n`);
    for (const item of failures) {
      process.stderr.write(`- [${item.id}] ${item.message}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`App Store ${options.mode} verification: PASS\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCLI().catch((error) => {
    process.stderr.write(`App Store verifier crashed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
