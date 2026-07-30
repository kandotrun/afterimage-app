import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  verifyPrivacyManifest,
  verifyRepository,
  verifyScreenshotManifest,
  verifyTargetFamilies,
  verifyWorkflowTrust,
} from "../verify-app-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name) => readFileSync(
  path.join(root, "scripts", "fixtures", "app-store", name),
  "utf8",
);

test("iPad を含む app target を target 単位で拒否する", () => {
  const failures = verifyTargetFamilies(fixture("project-ipad.yml"));

  assert.ok(
    failures.some((failure) =>
      failure.id === "target.afterimage.device-family"
      && failure.message.includes('TARGETED_DEVICE_FAMILY="1"')
    ),
  );
});

test("Privacy Manifest の UserDefaults CA92.1 欠落を具体的に報告する", () => {
  const failures = verifyPrivacyManifest(fixture("privacy-missing-userdefaults.xcprivacy"));

  assert.ok(
    failures.some((failure) =>
      failure.id === "privacy.required-reason.user-defaults"
      && failure.message.includes("CA92.1")
    ),
  );
});

test("スクリーンショット manifest は三画面と意味のある合成内容を要求する", () => {
  const manifest = JSON.parse(fixture("screenshot-manifest-invalid.json"));
  const failures = verifyScreenshotManifest(manifest);

  assert.ok(
    failures.some((failure) =>
      failure.id === "screenshots.minimum-count"
      && failure.message.includes("3")
    ),
  );
  assert.ok(
    failures.some((failure) =>
      failure.id === "screenshots.content-coverage"
      && failure.message.includes("location")
      && failure.message.includes("transcript")
      && failure.message.includes("analysis")
    ),
  );
});

test("PR workflow の secrets と runner mutation を job scope で拒否する", () => {
  const failures = verifyWorkflowTrust([
    {
      path: ".github/workflows/unsafe.yml",
      content: fixture("workflow-untrusted-pr.yml"),
    },
  ]);

  assert.ok(
    failures.some((failure) =>
      failure.id === "ci.pr.permissions"
      && failure.message.includes("contents: read")
    ),
  );
  assert.ok(
    failures.some((failure) =>
      failure.id === "ci.pr.secrets"
      && failure.message.includes("unsafe.yml")
    ),
  );
  assert.ok(
    failures.some((failure) =>
      failure.id === "ci.pr.runner-mutation"
      && failure.message.includes("brew install")
    ),
  );
});

test("submission mode は未生成macOS artifactと未検証evidenceを列挙する", () => {
  const failures = verifyRepository({
    root,
    mode: "submission",
    screenshotsDirectory: "scripts/fixtures/app-store/no-artifacts",
  });

  for (const id of [
    "submission.AUTH_CHALLENGE",
    "submission.ACCOUNT_DELETION",
    "submission.AI_CONSENT",
    "screenshots.artifact.01-private-timeline.png",
    "screenshots.artifact.02-memory-detail.png",
    "screenshots.artifact.03-ai-analysis.png",
  ]) {
    assert.ok(
      failures.some((failure) => failure.id === id),
      `submission failure is missing: ${id}`,
    );
  }
});
