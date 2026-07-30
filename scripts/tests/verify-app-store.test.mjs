import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

import {
  readPngMetadata,
  verifyEvidence,
  verifyEvidenceProvenance,
  verifyDeployWorkflow,
  verifyBackendWorkflow,
  verifyBackendRolloutScript,
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

const pngChunk = (type, data = Buffer.alloc(0)) => {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 8 + data.length);
  return chunk;
};

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
  assert.ok(
    failures.some((failure) =>
      failure.id === "ci.pr.self-hosted"
      && failure.message.includes("unsafe.yml")
    ),
  );
});

test("self-hosted PR guard は step-level if では代用できない", () => {
  const failures = verifyWorkflowTrust([{
    path: ".github/workflows/step-guard-only.yml",
    content: `name: step-guard-only
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: [self-hosted, macOS, ARM64, afterimage-ci]
    steps:
      - name: Misleading guarded step
        if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
        run: npm test
`,
  }]);

  assert.ok(
    failures.some((failure) => failure.id === "ci.pr.self-hosted"),
  );
});

test("self-hosted PR guard はquoted job IDでも必須", () => {
  const failures = verifyWorkflowTrust([{
    path: ".github/workflows/quoted-job.yml",
    content: `name: quoted-job
on:
  pull_request:
permissions:
  contents: read
jobs:
  "te\\u0073t":
    runs-on: [self-hosted, macOS, ARM64, afterimage-ci]
    steps:
      - run: npm test
`,
  }]);

  assert.ok(
    failures.some((failure) => failure.id === "ci.pr.self-hosted"),
  );
});

test("self-hosted PR workflow はjob guardがあっても拒否する", () => {
  const failures = verifyWorkflowTrust([{
    path: ".github/workflows/guarded-pr.yml",
    content: `name: guarded-pr
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: [self-hosted, macOS, ARM64, afterimage-ci]
    steps:
      - run: npm test
`,
  }]);

  assert.ok(failures.some((failure) => failure.id === "ci.pr.self-hosted"));
});

test("pull_request_target からself-hosted runnerを実行できない", () => {
  const failures = verifyWorkflowTrust([{
    path: ".github/workflows/pr-target.yml",
    content: `name: pr-target
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  test:
    runs-on: [self-hosted, macOS, ARM64, afterimage-ci]
    steps:
      - run: npm test
`,
  }]);

  assert.ok(failures.some((failure) => failure.id === "ci.pr.self-hosted"));
});

test("PR trigger はreusable workflow経由でも全面拒否する", () => {
  const failures = verifyWorkflowTrust([{
    path: ".github/workflows/pr-caller.yml",
    content: `name: pr-caller
on:
  pull_request:
permissions:
  contents: read
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
`,
  }, {
    path: ".github/workflows/reusable.yml",
    content: `name: reusable
on:
  workflow_call:
jobs:
  test:
    runs-on: [self-hosted, macOS, ARM64, afterimage-ci]
    steps:
      - run: npm test
`,
  }]);

  assert.ok(failures.some((failure) => failure.id === "ci.pr.trigger"));
});

test("backend workflow はcheck成功後のmain pushだけでproduction deployし、configをcleanupする", () => {
  const safe = [
    "name: backend",
    "on:",
    "  push:",
    "    branches: [\"**\"]",
    "  workflow_dispatch:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  check:",
    "    runs-on: [self-hosted, macOS, ARM64, afterimage-ci]",
    "    steps:",
    "      - run: npm run check",
    "  deploy:",
    "    needs: check",
    "    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    "    runs-on: [self-hosted, macOS, ARM64, afterimage-ci]",
    "    steps:",
    "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567",
    "      - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567",
    "      - run: npm ci",
    "      - name: Deploy backend to production",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          AFTERIMAGE_PRODUCTION_WRANGLER_CONFIG: ${{ secrets.AFTERIMAGE_PRODUCTION_WRANGLER_CONFIG }}",
    "        run: |",
    "          set -euo pipefail",
    "          CONFIG_DIR=\"$(mktemp -d \"${RUNNER_TEMP%/}/afterimage-wrangler.XXXXXX\")\"",
    "          CONFIG_PATH=\"$CONFIG_DIR/wrangler.jsonc\"",
    "          cleanup() {",
    "            if [[ \"$CONFIG_DIR\" == \"${RUNNER_TEMP%/}\"/afterimage-wrangler.* ]]; then",
    "              rm -rf -- \"$CONFIG_DIR\"",
    "            fi",
    "          }",
    "          trap cleanup EXIT",
    "          printf '%s' \"$AFTERIMAGE_PRODUCTION_WRANGLER_CONFIG\" > \"$CONFIG_PATH\"",
    "          node --input-type=module - \"$CONFIG_PATH\" \"$GITHUB_WORKSPACE/backend\" <<'NODE'",
    "          const mainPath = path.join(backendRoot, \"src\", \"index.ts\");",
    "          const migrationsPath = path.join(backendRoot, \"migrations\");",
    "          NODE",
    "          export WRANGLER_CONFIG=\"$CONFIG_PATH\"",
    "          ./scripts/deploy-backend-production.sh",
  ].join("\n");
  const unsafe = safe.replace(
    "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
    "github.event_name == 'pull_request'",
  );
  const always = safe.replace(
    "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    "if: always() && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
  );
  const missingCheck = safe.replace("  check:\n", "  verify:\n");
  const configWriteLine = "          printf '%s' \"$AFTERIMAGE_PRODUCTION_WRANGLER_CONFIG\" > \"$CONFIG_PATH\"";
  const configAfterDeploy = safe
    .replace(`${configWriteLine}\n`, "")
    .replace(
      "          ./scripts/deploy-backend-production.sh",
      `          ./scripts/deploy-backend-production.sh\n${configWriteLine}`,
    );

  assert.deepEqual(verifyBackendWorkflow(safe), []);
  assert.ok(
    verifyBackendWorkflow(unsafe).some((failure) => failure.id === "ci.backend.main-gate"),
  );
  assert.ok(
    verifyBackendWorkflow(always).some((failure) => failure.id === "ci.backend.main-gate"),
  );
  assert.ok(
    verifyBackendWorkflow(missingCheck).some((failure) => failure.id === "ci.backend.check-job"),
  );
  assert.ok(
    verifyBackendWorkflow(configAfterDeploy).some((failure) => failure.id === "ci.backend.config-cleanup"),
  );
});

test("TestFlight export前にarchive read-back gateを要求する", () => {
  const source = readFileSync(
    path.join(root, ".github", "workflows", "ios-deploy.yml"),
    "utf8",
  );
  const failures = verifyDeployWorkflow(source);
  const unsafe = source.replace(
    /      - name: Verify archived app before export\n[\s\S]*?(?=      - name: Export and upload to TestFlight)/,
    "",
  );
  const missingCommitEmbedding = source.replace(
    '            AFTERIMAGE_BUILD_COMMIT="$GITHUB_SHA" \\\n',
    "",
  );
  const disabledReadback = source.replace(
    "      - name: Verify archived app before export\n        run:",
    "      - name: Verify archived app before export\n        if: false\n        run:",
  );

  assert.equal(
    failures.some((failure) => failure.id === "ci.deploy.archive-readback"),
    false,
  );
  assert.ok(
    verifyDeployWorkflow(unsafe).some((failure) =>
      failure.id === "ci.deploy.archive-readback"
    ),
  );
  assert.ok(
    verifyDeployWorkflow(missingCommitEmbedding).some((failure) =>
      failure.id === "ci.deploy.archive-readback"
    ),
  );
  assert.ok(
    verifyDeployWorkflow(disabledReadback).some((failure) =>
      failure.id === "ci.deploy.archive-readback"
    ),
  );
});

test("production backend rollout はmaintenance→migration→final deploy順を要求する", () => {
  const safe = `
wrangler secret list --config "$WRANGLER_CONFIG"
require_binding APPLE_TEAM_ID
require_binding APPLE_KEY_ID
require_secret APPLE_PRIVATE_KEY
wrangler deploy src/maintenance.ts --config "$WRANGLER_CONFIG"
expect_status 503
wrangler d1 migrations apply "$D1_DATABASE" --remote --config "$WRANGLER_CONFIG"
wrangler deploy --config "$WRANGLER_CONFIG"
expect_status 200
`;
  const missingAppleCredentials = `
wrangler deploy src/maintenance.ts --config "$WRANGLER_CONFIG"
expect_status 503
wrangler d1 migrations apply "$D1_DATABASE" --remote --config "$WRANGLER_CONFIG"
wrangler deploy --config "$WRANGLER_CONFIG"
expect_status 200
`;
  const unsafe = `
wrangler d1 migrations apply "$D1_DATABASE" --remote --config "$WRANGLER_CONFIG"
wrangler deploy --config "$WRANGLER_CONFIG"
`;

  assert.deepEqual(verifyBackendRolloutScript(safe), []);
  assert.ok(verifyBackendRolloutScript(unsafe).some((failure) =>
    failure.id === "backend.rollout.order"
  ));
  assert.ok(verifyBackendRolloutScript(missingAppleCredentials).some((failure) =>
    failure.id === "backend.rollout.apple-credentials"
  ));
});

test("PNG verifier は IHDR だけの切断artifactを拒否する", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1320, 0);
  ihdr.writeUInt32BE(2868, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const truncated = Buffer.concat([signature, pngChunk("IHDR", ihdr)]);

  assert.throws(
    () => readPngMetadata(truncated),
    /IEND|切断/,
  );
});

test("PNG verifier は IDAT のないCRC-valid artifactを拒否する", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1320, 0);
  ihdr.writeUInt32BE(2868, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const artifact = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IEND"),
  ]);

  assert.throws(
    () => readPngMetadata(artifact),
    /IDAT/,
  );
});

test("PNG verifier はCRC破損artifactを拒否する", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1320, 0);
  ihdr.writeUInt32BE(2868, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const corruptIDAT = pngChunk("IDAT", Buffer.from([0]));
  corruptIDAT[corruptIDAT.length - 1] ^= 1;
  const artifact = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    corruptIDAT,
    pngChunk("IEND"),
  ]);

  assert.throws(
    () => readPngMetadata(artifact),
    /CRC/,
  );
});

test("PNG verifier はCRC-validでも展開不能なIDATを拒否する", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const artifact = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from([0])),
    pngChunk("IEND"),
  ]);

  assert.throws(
    () => readPngMetadata(artifact),
    /IDAT|展開/,
  );
});

test("PNG verifier は展開可能なRGB scanlineを受理する", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const artifact = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    pngChunk("IEND"),
  ]);

  assert.deepEqual(readPngMetadata(artifact), {
    width: 1,
    height: 1,
    bitDepth: 8,
    colorType: 2,
  });
});

test("PNG verifier はtRNS透明度を持つRGB artifactを拒否する", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const artifact = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("tRNS", Buffer.alloc(6)),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))),
    pngChunk("IEND"),
  ]);

  assert.throws(() => readPngMetadata(artifact), /透明|tRNS/);
});

test("PNG verifier はduplicate IHDRを拒否する", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const artifact = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    pngChunk("IEND"),
  ]);

  assert.throws(() => readPngMetadata(artifact), /IHDR/);
});

test("PNG verifier はPLTEのないindexed-color PNGを拒否する", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const artifact = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    pngChunk("IEND"),
  ]);

  assert.throws(() => readPngMetadata(artifact), /PLTE/);
});

test("verified evidence はrelease commitへbindした構造化証跡を要求する", () => {
  const releaseCommit = "a".repeat(40);
  const failures = verifyEvidence({
    version: 1,
    releaseCommit,
    entries: [{
      id: "AUTH_CHALLENGE",
      status: "verified",
      requiredForSubmission: true,
      instructions: "nonce replayをCIで検証する。",
      evidence: [
        "looks good",
        {
          type: "github_actions",
          result: "passed",
          commit: "b".repeat(40),
          recordedAt: "2026-07-30T04:00:00.000Z",
          url: "https://github.com/kandotrun/afterimage-app/actions/runs/1",
          details: "backend nonce replay tests passed",
        },
      ],
    }],
  }, "submission");

  assert.ok(failures.some((failure) => failure.id === "evidence.AUTH_CHALLENGE.item.0"));
  assert.ok(failures.some((failure) => failure.id === "evidence.AUTH_CHALLENGE.item.1.commit"));
  assert.ok(failures.some((failure) =>
    failure.id === "evidence.AUTH_CHALLENGE.item.1.provenance"
  ));
});

test("evidence は要件ごとの許可workflow/jobへbindする", () => {
  const releaseCommit = "a".repeat(40);
  const failures = verifyEvidence({
    version: 1,
    releaseCommit,
    entries: [{
      id: "IOS_TESTS",
      status: "verified",
      requiredForSubmission: true,
      instructions: "self-hosted macOSでiOS testを実行する。",
      evidence: [{
        type: "github_actions",
        result: "passed",
        commit: releaseCommit,
        recordedAt: "2026-07-30T04:00:00.000Z",
        url: "https://github.com/kandotrun/afterimage-app/actions/runs/123",
        details: "unrelated backend job was reused as iOS evidence",
        runId: 123,
        runAttempt: 1,
        workflowPath: ".github/workflows/backend.yml",
        jobName: "backend",
      }],
    }],
  }, "contracts");

  assert.ok(failures.some((failure) =>
    failure.id === "evidence.IOS_TESTS.item.0.policy"
  ));
});

test("remote provenance は別commitのGitHub Actions runを拒否する", async () => {
  const releaseCommit = "a".repeat(40);
  const evidence = {
    releaseCommit,
    entries: [{
      id: "IOS_TESTS",
      status: "verified",
      evidence: [{
        type: "github_actions",
        result: "passed",
        commit: releaseCommit,
        recordedAt: "2026-07-30T04:00:00.000Z",
        url: "https://github.com/kandotrun/afterimage-app/actions/runs/123",
        details: "self-hosted iOS tests passed",
        runId: 123,
        runAttempt: 1,
        workflowPath: ".github/workflows/ios.yml",
        jobName: "test",
      }],
    }],
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: 123,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_sha: "b".repeat(40),
      run_attempt: 1,
      path: ".github/workflows/ios.yml",
      html_url: "https://github.com/kandotrun/afterimage-app/actions/runs/123",
      repository: { full_name: "kandotrun/afterimage-app" },
    }),
  });

  const failures = await verifyEvidenceProvenance(evidence, { fetchImpl });

  assert.ok(failures.some((failure) =>
    failure.id === "provenance.IOS_TESTS.0.run.commit"
  ));
});

test("remote provenance はpull request runを拒否する", async () => {
  const releaseCommit = "a".repeat(40);
  const evidence = {
    releaseCommit,
    entries: [{
      id: "IOS_TESTS",
      status: "verified",
      evidence: [{
        type: "github_actions",
        result: "passed",
        commit: releaseCommit,
        recordedAt: "2026-07-30T00:00:00.000Z",
        url: "https://github.com/kandotrun/afterimage-app/actions/runs/123",
        details: "A concrete but untrusted pull request run for provenance validation.",
        runId: 123,
        runAttempt: 1,
        workflowPath: ".github/workflows/ios.yml",
        jobName: "test",
      }],
    }],
  };
  const response = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
  });
  const fetchImpl = async (url) => {
    if (url.endsWith("/jobs?per_page=100")) {
      return response({ jobs: [{
        name: "test",
        status: "completed",
        conclusion: "success",
        head_sha: releaseCommit,
        run_attempt: 1,
      }] });
    }
    return response({
      id: 123,
      status: "completed",
      conclusion: "success",
      event: "pull_request",
      head_sha: releaseCommit,
      run_attempt: 1,
      path: ".github/workflows/ios.yml",
      html_url: "https://github.com/kandotrun/afterimage-app/actions/runs/123",
      repository: { full_name: "kandotrun/afterimage-app" },
    });
  };

  const failures = await verifyEvidenceProvenance(evidence, { fetchImpl });

  assert.ok(failures.some((failure) =>
    failure.id === "provenance.IOS_TESTS.0.run.event"
  ));
});

test("remote provenance は同一commitの成功run/jobを受理する", async () => {
  const releaseCommit = "a".repeat(40);
  const evidence = {
    releaseCommit,
    entries: [{
      id: "IOS_TESTS",
      status: "verified",
      evidence: [{
        type: "github_actions",
        result: "passed",
        commit: releaseCommit,
        recordedAt: "2026-07-30T04:00:00.000Z",
        url: "https://github.com/kandotrun/afterimage-app/actions/runs/123",
        details: "self-hosted iOS tests passed",
        runId: 123,
        runAttempt: 1,
        workflowPath: ".github/workflows/ios.yml",
        jobName: "test",
      }],
    }],
  };
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => url.endsWith("/jobs?per_page=100")
      ? {
          jobs: [{
            name: "test",
            status: "completed",
            conclusion: "success",
            head_sha: releaseCommit,
            run_attempt: 1,
          }],
        }
      : {
          id: 123,
          status: "completed",
          conclusion: "success",
          event: "push",
          head_sha: releaseCommit,
          run_attempt: 1,
          path: ".github/workflows/ios.yml",
          html_url: "https://github.com/kandotrun/afterimage-app/actions/runs/123",
          repository: { full_name: "kandotrun/afterimage-app" },
        },
  });

  const failures = await verifyEvidenceProvenance(evidence, { fetchImpl });

  assert.deepEqual(failures, []);
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
