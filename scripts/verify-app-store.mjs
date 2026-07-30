import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG IHDR がありません");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
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

function extractRunCommands(source) {
  const lines = normalizedLines(source);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline = line.match(/^\s*-\s+run:\s+(.+)$/) ?? line.match(/^\s+run:\s+(.+)$/);
    if (!inline) continue;
    const baseIndent = leadingSpaces(line);
    const value = inline[1].trim();
    if (value !== "|" && value !== ">") {
      commands.push(value);
      continue;
    }
    for (index += 1; index < lines.length; index += 1) {
      const commandLine = lines[index];
      if (commandLine.trim() && leadingSpaces(commandLine) <= baseIndent) {
        index -= 1;
        break;
      }
      if (commandLine.trim()) commands.push(commandLine.trim());
    }
  }
  return commands;
}

function workflowHasTrigger(source, trigger) {
  return extractYamlBlock(source, "on")
    .some((line) => line.trim() === `${trigger}:` || line.trim().startsWith(`${trigger}: `));
}

function topLevelPermissions(source) {
  const permissions = extractYamlBlock(source, "permissions");
  return permissions
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(":").map((part) => part.trim()))
    .filter((parts) => parts.length === 2);
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

export function verifyWorkflowTrust(workflows) {
  const failures = [];
  for (const workflow of workflows) {
    if (workflowHasTrigger(workflow.content, "pull_request_target")) {
      failures.push(failure(
        "ci.pull-request-target",
        `${workflow.path} は privileged pull_request_target を使用できません。`,
      ));
    }
    const runsOn = normalizedLines(workflow.content)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("runs-on:"))
      .map((line) => line.slice("runs-on:".length).trim());
    for (const runner of runsOn) {
      if (runner !== expectedRunner) {
        failures.push(failure(
          "ci.runner-labels",
          `${workflow.path} は runs-on: ${expectedRunner} を使用する必要があります。`,
        ));
      }
    }

    for (const line of normalizedLines(workflow.content)) {
      const match = line.trim().match(/^(?:-\s+)?uses:\s+([^\s#]+)/);
      if (!match || match[1].startsWith("./")) continue;
      const reference = match[1].split("@")[1] ?? "";
      if (!/^[0-9a-f]{40}$/i.test(reference)) {
        failures.push(failure(
          "ci.action-pin",
          `${workflow.path} の ${match[1]} は full commit SHA で pin してください。`,
        ));
      }
    }

    if (!workflowHasTrigger(workflow.content, "pull_request")) continue;
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
    const forbidden = extractRunCommands(workflow.content).find((command) =>
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

function verifyDeployWorkflow(source) {
  const failures = [];
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

function verifyEvidence(evidence, mode) {
  const failures = [];
  if (!evidence) return failures;
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
    if (mode === "submission"
        && (entry.status !== "verified" || entry.evidence.length === 0)) {
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

function runCLI() {
  const options = parseArguments(process.argv.slice(2));
  const failures = verifyRepository(options);
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
  runCLI();
}
