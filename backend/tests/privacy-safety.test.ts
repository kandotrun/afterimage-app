import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredState, createApp, type AppleIdentity } from "../src/app";
import { processPendingAccountDeletions } from "../src/account-deletion";

const NOW = new Date("2026-07-30T00:00:00.000Z");
const AI_CONSENT_VERSION = "2026-07-30";

type AppleVerifier = (
  identityToken: string,
  audience: string,
  expectedNonce?: string,
) => Promise<AppleIdentity>;

type AccountDeletionOverrides = {
  exchangeAppleAuthorizationCode: (
    bindings: Env,
    authorizationCode: string,
  ) => Promise<{
    token: string;
    tokenType: "refresh_token" | "access_token";
    identityToken: string;
  }>;
  revokeAppleToken: (
    bindings: Env,
    token: string,
    tokenType: "refresh_token" | "access_token",
  ) => Promise<void>;
  deleteSonioxResources: (
    bindings: Env,
    transcriptionId: string | null,
    fileId: string | null,
  ) => Promise<void>;
};

function makeApp(
  clock: { value: Date } = { value: NOW },
  verifier: AppleVerifier = async (identityToken) => ({
    subject: identityToken.replace("token-for-", ""),
  }),
) {
  return createApp({
    verifyAppleIdentityToken: verifier,
    now: () => clock.value,
  });
}

function makeDeletionApp(
  clock: { value: Date },
  accountDeletion: AccountDeletionOverrides,
) {
  const options = {
    verifyAppleIdentityToken: async (identityToken: string) => ({
      subject: identityToken.replace("token-for-", "").split("#", 1)[0]!,
    }),
    now: () => clock.value,
    accountDeletion,
  };
  return createApp(options);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function issueChallenge(
  app: ReturnType<typeof createApp>,
  ip = "203.0.113.10",
  bindings: Env = env,
) {
  const response = await app.request("/v1/auth/apple/challenge", {
    headers: { "cf-connecting-ip": ip },
  }, bindings);
  const body = await response.json<{
    challengeId: string;
    nonce: string;
    expiresAt: string;
  }>();
  return { response, body };
}

async function signIn(
  subject: string,
  app = makeApp(),
  bindings: Env = env,
) {
  const { body: challenge } = await issueChallenge(app, `203.0.113.${subject.length + 20}`, bindings);
  const response = await app.request("/v1/auth/apple", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      identityToken: `token-for-${subject}`,
    }),
  }, bindings);
  expect(response.status).toBe(200);
  const body = await response.json<{ token: string; user: { id: string } }>();
  return {
    app,
    authorization: `Bearer ${body.token}`,
    userId: body.user.id,
  };
}

async function accountDeletionCredentials(
  app: ReturnType<typeof createApp>,
  subject: string,
  authorizationCode: string,
  bindings: Env = env,
) {
  const { body: challenge } = await issueChallenge(
    app,
    `198.51.100.${subject.length + 20}`,
    bindings,
  );
  return {
    challengeId: challenge.challengeId,
    identityToken: `token-for-${subject}#deletion-${challenge.challengeId}`,
    authorizationCode,
  };
}

async function setConsent(
  owner: Awaited<ReturnType<typeof signIn>>,
  consented: boolean,
  bindings: Env = env,
) {
  return owner.app.request("/v1/privacy/ai", {
    method: "PUT",
    headers: {
      authorization: owner.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ version: AI_CONSENT_VERSION, consented }),
  }, bindings);
}

async function createAsset(
  owner: Awaited<ReturnType<typeof signIn>>,
  overrides: Record<string, unknown> = {},
  bindings: Env = env,
) {
  return owner.app.request("/v1/assets", {
    method: "POST",
    headers: {
      authorization: owner.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "video",
      filename: `${crypto.randomUUID()}.mp4`,
      contentType: "video/mp4",
      byteSize: 5,
      capturedAt: NOW.toISOString(),
      durationMs: 1_000,
      ...overrides,
    }),
  }, bindings);
}

function envWithDeletionMediaHooks(hooks: {
  abort?: () => void;
  beforeAbort?: () => void;
  beforeDelete?: () => void;
}): Env {
  const media = new Proxy(env.MEDIA, {
    get(target, property) {
      if (property === "delete") {
        return async (keys: string | string[]) => {
          hooks.beforeDelete?.();
          return target.delete(keys);
        };
      }
      if (property === "resumeMultipartUpload") {
        return (key: string, uploadId: string) => {
          const upload = target.resumeMultipartUpload(key, uploadId);
          return new Proxy(upload, {
            get(multipart, member) {
              if (member === "abort") {
                return async () => {
                  hooks.beforeAbort?.();
                  await multipart.abort();
                  hooks.abort?.();
                };
              }
              const value = Reflect.get(multipart, member, multipart) as unknown;
              return typeof value === "function" ? value.bind(multipart) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, MEDIA: media };
}

beforeEach(async () => {
  const statements = [
    "DELETE FROM account_deletion_receipts",
    "DELETE FROM account_deletion_assets",
    "DELETE FROM account_deletion_jobs",
    "DELETE FROM soniox_cleanup_outbox",
    "DELETE FROM asset_creation_ledger",
    "DELETE FROM external_ai_work_leases",
    "DELETE FROM ai_consents",
    "DELETE FROM apple_auth_challenges",
    "DELETE FROM upload_parts",
    "DELETE FROM mcp_tokens",
    "DELETE FROM assets",
    "DELETE FROM sessions",
    "DELETE FROM users",
  ];
  for (const statement of statements) {
    try {
      await env.DB.prepare(statement).run();
    } catch {
    }
  }
  vi.restoreAllMocks();
});

describe("Apple authentication challenge", () => {
  it("binds a verified Apple nonce claim to one short-lived challenge", async () => {
    let challengeNonceHash: string | undefined;
    const app = makeApp({ value: NOW }, async (_token, audience, expectedNonce) => {
      expect(audience).toBe("com.2-38.afterimage");
      expect(expectedNonce).toBe(challengeNonceHash);
      return { subject: "nonce-owner", email: "owner@example.com" };
    });
    const { response, body: challenge } = await issueChallenge(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(challenge.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    challengeNonceHash = await sha256Hex(challenge.nonce);
    expect(new Date(challenge.expiresAt).getTime() - NOW.getTime()).toBe(5 * 60 * 1_000);

    const authenticated = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        identityToken: "valid-identity-token",
      }),
    }, env);
    expect(authenticated.status).toBe(200);

    const replay = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        identityToken: "valid-identity-token",
      }),
    }, env);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({
      error: { code: "invalid_apple_challenge" },
    });
  });

  it("rejects nonce mismatch, expiry, missing challenges, and token replay", async () => {
    const clock = { value: NOW };
    const tokenNonce = new Map<string, string>();
    const app = makeApp(clock, async (token, _audience, expectedNonce) => {
      if (!expectedNonce || tokenNonce.get(token) !== expectedNonce) {
        throw new Error("nonce mismatch");
      }
      return { subject: token };
    });

    const missing = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityToken: "missing-challenge-token" }),
    }, env);
    expect(missing.status).toBe(400);

    const mismatchChallenge = (await issueChallenge(app, "203.0.113.11")).body;
    tokenNonce.set("mismatched-token", "not-the-stored-nonce");
    const mismatch = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: mismatchChallenge.challengeId,
        identityToken: "mismatched-token",
      }),
    }, env);
    expect(mismatch.status).toBe(401);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: "invalid_apple_token" },
    });

    tokenNonce.set("mismatched-token", await sha256Hex(mismatchChallenge.nonce));
    const retryAfterMalformedToken = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: mismatchChallenge.challengeId,
        identityToken: "mismatched-token",
      }),
    }, env);
    expect(retryAfterMalformedToken.status).toBe(200);

    const expiredChallenge = (await issueChallenge(app, "203.0.113.12")).body;
    tokenNonce.set("expired-token", await sha256Hex(expiredChallenge.nonce));
    clock.value = new Date(NOW.getTime() + 5 * 60 * 1_000 + 1);
    const expired = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: expiredChallenge.challengeId,
        identityToken: "expired-token",
      }),
    }, env);
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "invalid_apple_challenge" },
    });

    clock.value = NOW;
    const firstChallenge = (await issueChallenge(app, "203.0.113.13")).body;
    tokenNonce.set("replayed-token", await sha256Hex(firstChallenge.nonce));
    const firstUse = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: firstChallenge.challengeId,
        identityToken: "replayed-token",
      }),
    }, env);
    expect(firstUse.status).toBe(200);

    const secondChallenge = (await issueChallenge(app, "203.0.113.14")).body;
    const tokenReplay = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: secondChallenge.challengeId,
        identityToken: "replayed-token",
      }),
    }, env);
    expect(tokenReplay.status).toBe(401);
  });

  it("rate-limits a trusted Cloudflare client and fails closed without it in production", async () => {
    const app = makeApp();
    const allowed = await Promise.all(
      Array.from({ length: 10 }, () => issueChallenge(app, "198.51.100.20")),
    );
    expect(allowed.every(({ response }) => response.status === 200)).toBe(true);

    const limited = await issueChallenge(app, "198.51.100.20");
    expect(limited.response.status).toBe(429);
    await expect(Promise.resolve(limited.body)).resolves.toMatchObject({
      error: { code: "apple_challenge_rate_limited" },
    });

    const otherClient = await issueChallenge(app, "198.51.100.21");
    expect(otherClient.response.status).toBe(200);

    const missingEdgeIp = await app.request("/v1/auth/apple/challenge", {
      headers: { "x-forwarded-for": "198.51.100.20" },
    }, { ...env, ENVIRONMENT: "production" });
    expect(missingEdgeIp.status).toBe(503);
    await expect(missingEdgeIp.json()).resolves.toMatchObject({
      error: { code: "trusted_client_ip_required" },
    });
  });
});

describe("explicit AI consent", () => {
  it("defaults consent and agent access off while private capture remains available", async () => {
    const owner = await signIn("consent-default");
    const privacy = await owner.app.request("/v1/privacy/ai", {
      headers: { authorization: owner.authorization },
    }, env);
    expect(privacy.status).toBe(200);
    await expect(privacy.json()).resolves.toEqual({
      consent: {
        version: AI_CONSENT_VERSION,
        consentedAt: null,
        withdrawnAt: null,
        active: false,
      },
      derivedDataRetention: "retained_until_asset_or_account_deletion",
    });

    const created = await createAsset(owner);
    expect(created.status).toBe(201);
    const body = await created.json<{ asset: { id: string; agentAccessEnabled: boolean } }>();
    expect(body.asset.agentAccessEnabled).toBe(false);

    const blockedAgentAccess = await owner.app.request(
      `/v1/assets/${body.asset.id}/agent-access`,
      {
        method: "PATCH",
        headers: {
          authorization: owner.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      },
      env,
    );
    expect(blockedAgentAccess.status).toBe(403);
    await expect(blockedAgentAccess.json()).resolves.toMatchObject({
      error: { code: "ai_consent_required" },
    });

    const blockedMcp = await owner.app.request("/v1/mcp/tokens", {
      method: "POST",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "No consent" }),
    }, env);
    expect(blockedMcp.status).toBe(403);
  });

  it("grants and withdraws the current consent version at the backend authority", async () => {
    const owner = await signIn("consent-lifecycle");
    const granted = await setConsent(owner, true);
    expect(granted.status).toBe(200);
    await expect(granted.json()).resolves.toMatchObject({
      consent: {
        version: AI_CONSENT_VERSION,
        consentedAt: NOW.toISOString(),
        withdrawnAt: null,
        active: true,
      },
    });

    const assetId = crypto.randomUUID();
    const processingAssetId = crypto.randomUUID();
    const analysisJobId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (
          id, user_id, kind, filename, content_type, byte_size, captured_at,
          status, object_key, upload_mode, created_at, updated_at,
          transcription_status, transcript, agent_access_enabled
        ) VALUES (?, ?, 'video', 'retained.mp4', 'video/mp4', 5, ?,
          'ready', ?, 'single', ?, ?, 'completed', 'retained transcript', 0)`,
      ).bind(
        assetId,
        owner.userId,
        NOW.toISOString(),
        `users/${owner.userId}/assets/${assetId}/media`,
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO assets (
          id, user_id, kind, filename, content_type, byte_size, captured_at,
          status, object_key, upload_mode, created_at, updated_at,
          transcription_status, transcription_updated_at,
          soniox_file_id, soniox_transcription_id
        ) VALUES (?, ?, 'video', 'processing.mp4', 'video/mp4', 5, ?,
          'ready', ?, 'single', ?, ?, 'processing', ?, 'consent-file', 'consent-job')`,
      ).bind(
        processingAssetId,
        owner.userId,
        NOW.toISOString(),
        `users/${owner.userId}/assets/${processingAssetId}/media`,
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO video_analyses (
          asset_id, job_id, model_id, model_revision, backend, coverage_mode,
          summary, created_at, updated_at
        ) VALUES (?, ?, 'microsoft/Mage-VL', 'revision', 'frames', 'full',
          'retained analysis', ?, ?)`,
      ).bind(assetId, analysisJobId, NOW.toISOString(), NOW.toISOString()),
    ]);

    const enabled = await owner.app.request(`/v1/assets/${assetId}/agent-access`, {
      method: "PATCH",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    }, env);
    expect(enabled.status).toBe(200);

    const tokenResponse = await owner.app.request("/v1/mcp/tokens", {
      method: "POST",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Consent lifecycle" }),
    }, env);
    expect(tokenResponse.status).toBe(201);
    const { token } = await tokenResponse.json<{ token: string }>();

    const withdrawn = await setConsent(owner, false);
    expect(withdrawn.status).toBe(200);
    await expect(withdrawn.json()).resolves.toMatchObject({
      consent: {
        active: false,
        withdrawnAt: NOW.toISOString(),
      },
      derivedDataRetention: "retained_until_asset_or_account_deletion",
    });

    expect(await env.DB.prepare(
      "SELECT agent_access_enabled, transcript FROM assets WHERE id = ?",
    ).bind(assetId).first()).toMatchObject({
      agent_access_enabled: 0,
      transcript: "retained transcript",
    });
    expect(await env.DB.prepare(
      `SELECT transcription_status, transcript_error,
              soniox_file_id, soniox_transcription_id
         FROM assets WHERE id = ?`,
    ).bind(processingAssetId).first()).toEqual({
      transcription_status: "failed",
      transcript_error: "consent_withdrawn_cleanup_pending",
      soniox_file_id: null,
      soniox_transcription_id: null,
    });
    expect(await env.DB.prepare(
      `SELECT asset_id, user_id, soniox_file_id, soniox_transcription_id, promoted_at
         FROM soniox_cleanup_outbox WHERE asset_id = ?`,
    ).bind(processingAssetId).first()).toEqual({
      asset_id: processingAssetId,
      user_id: owner.userId,
      soniox_file_id: "consent-file",
      soniox_transcription_id: "consent-job",
      promoted_at: null,
    });
    expect(await env.DB.prepare(
      "SELECT summary FROM video_analyses WHERE asset_id = ?",
    ).bind(assetId).first()).toMatchObject({ summary: "retained analysis" });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM gpu_jobs WHERE asset_id = ?",
    ).bind(assetId).first<{ count: number }>()).toMatchObject({ count: 0 });

    const mcp = await owner.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }, env);
    expect(mcp.status).toBe(401);

    const transcript = await owner.app.request(`/v1/assets/${assetId}/transcript`, {
      headers: { authorization: owner.authorization },
    }, env);
    expect(transcript.status).toBe(200);
  });

  it("queues new Soniox and Mage work only after active consent", async () => {
    const bindings = { ...env, SONIOX_API_KEY: "test-soniox-key" };
    const owner = await signIn("consent-ai-queue", makeApp(), bindings);
    const withoutConsent = await createAsset(owner, { filename: "without.mp4" }, bindings);
    const without = await withoutConsent.json<{ asset: { id: string } }>();
    await owner.app.request(`/v1/assets/${without.asset.id}/upload`, {
      method: "PUT",
      headers: {
        authorization: owner.authorization,
        "content-type": "video/mp4",
        "content-length": "5",
      },
      body: "video",
    }, bindings);
    await owner.app.request(`/v1/assets/${without.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization: owner.authorization },
    }, bindings);
    expect(await env.DB.prepare(
      "SELECT transcription_status FROM assets WHERE id = ?",
    ).bind(without.asset.id).first()).toMatchObject({ transcription_status: null });

    expect((await setConsent(owner, true, bindings)).status).toBe(200);
    const withConsent = await createAsset(owner, { filename: "with.mp4" }, bindings);
    const withBody = await withConsent.json<{ asset: { id: string } }>();
    await owner.app.request(`/v1/assets/${withBody.asset.id}/upload`, {
      method: "PUT",
      headers: {
        authorization: owner.authorization,
        "content-type": "video/mp4",
        "content-length": "5",
      },
      body: "video",
    }, bindings);
    await owner.app.request(`/v1/assets/${withBody.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization: owner.authorization },
    }, bindings);
    expect(await env.DB.prepare(
      "SELECT transcription_status, agent_access_enabled FROM assets WHERE id = ?",
    ).bind(withBody.asset.id).first()).toMatchObject({
      transcription_status: "pending",
      agent_access_enabled: 0,
    });
  });

  it("blocks Qwen before consent and caps concurrent external-AI work at four", async () => {
    const releases: Array<(value: { summary: string; model: string }) => void> = [];
    let generatorCalls = 0;
    const generateDailySummary = vi.fn(async () => {
      generatorCalls += 1;
      if (generatorCalls === 5) {
        return { summary: "上限を超えた要約", model: "qwen3.8-max-preview" };
      }
      return new Promise<{ summary: string; model: string }>((resolve) => {
        releases.push(resolve);
      });
    });
    const app = createApp({
      verifyAppleIdentityToken: async (identityToken) => ({
        subject: identityToken.replace("token-for-", ""),
      }),
      generateDailySummary,
      now: () => NOW,
    });
    const bindings = env;
    const owner = await signIn("consent-qwen", app, bindings);
    const assetId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO assets (
        id, user_id, kind, filename, content_type, byte_size, captured_at,
        status, object_key, upload_mode, created_at, updated_at,
        transcription_status, transcript
      ) VALUES (?, ?, 'video', 'qwen.mp4', 'video/mp4', 5, ?,
        'ready', ?, 'single', ?, ?, 'completed', '一日の記録')`,
    ).bind(
      assetId,
      owner.userId,
      "2026-07-29T12:00:00.000Z",
      `users/${owner.userId}/assets/${assetId}/media`,
      NOW.toISOString(),
      NOW.toISOString(),
    ).run();
    const path = "/v1/days/summary?startAt=2026-07-29T00%3A00%3A00.000Z&endAt=2026-07-30T00%3A00%3A00.000Z";
    const requestSummary = () => app.request(path, {
      headers: { authorization: owner.authorization },
    }, bindings);

    const beforeConsent = await requestSummary();
    expect(beforeConsent.status).toBe(403);
    expect(generateDailySummary).not.toHaveBeenCalled();

    expect((await setConsent(owner, true, bindings)).status).toBe(200);
    const requests = Array.from({ length: 5 }, requestSummary);
    const firstCompleted = await Promise.race(requests);
    expect(firstCompleted.status).toBe(429);
    await expect(firstCompleted.json()).resolves.toMatchObject({
      error: { code: "external_ai_work_limit" },
    });
    expect(generateDailySummary).toHaveBeenCalledTimes(4);

    for (const release of releases) {
      release({ summary: "一日の記録を振り返った。", model: "qwen3.8-max-preview" });
    }
    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(4);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });

  it("does not persist a Qwen result after consent is withdrawn in flight", async () => {
    let release: ((value: { summary: string; model: string }) => void) | undefined;
    const generateDailySummary = vi.fn(() => (
      new Promise<{ summary: string; model: string }>((resolve) => {
        release = resolve;
      })
    ));
    const app = createApp({
      verifyAppleIdentityToken: async (identityToken) => ({
        subject: identityToken.replace("token-for-", ""),
      }),
      generateDailySummary,
      now: () => NOW,
    });
    const owner = await signIn("consent-qwen-withdrawal", app);
    const assetId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO assets (
        id, user_id, kind, filename, content_type, byte_size, captured_at,
        status, object_key, upload_mode, created_at, updated_at,
        transcription_status, transcript
      ) VALUES (?, ?, 'video', 'qwen-withdrawal.mp4', 'video/mp4', 5, ?,
        'ready', ?, 'single', ?, ?, 'completed', '一日の記録')`,
    ).bind(
      assetId,
      owner.userId,
      "2026-07-29T12:00:00.000Z",
      `users/${owner.userId}/assets/${assetId}/media`,
      NOW.toISOString(),
      NOW.toISOString(),
    ).run();
    expect((await setConsent(owner, true)).status).toBe(200);
    const pending = app.request(
      "/v1/days/summary?startAt=2026-07-29T00%3A00%3A00.000Z&endAt=2026-07-30T00%3A00%3A00.000Z",
      { headers: { authorization: owner.authorization } },
      env,
    );
    await vi.waitFor(() => expect(generateDailySummary).toHaveBeenCalledOnce());
    expect((await setConsent(owner, false)).status).toBe(200);
    release!({
      summary: "同意撤回後には保存しない。",
      model: "qwen3.8-max-preview",
    });

    const response = await pending;
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ai_consent_required" },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM daily_summaries WHERE user_id = ?",
    ).bind(owner.userId).first<{ count: number }>()).toEqual({ count: 0 });
  });
});

describe("public legal and support pages", () => {
  it.each(["/privacy", "/support", "/terms"])(
    "serves %s without authentication using no-store security headers",
    async (path) => {
      const response = await makeApp().request(path, {}, env);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const html = await response.text();
      expect(html).toContain("Afterimage");
      if (path === "/privacy") {
        expect(html).toContain("Soniox");
        expect(html).toContain("Alibaba Cloud Qwen");
        expect(html).toContain("consent");
        expect(html).toContain("delete");
        expect(html).toContain("kan@2-38.com");
      }
    },
  );
});

describe("durable account deletion", () => {
  function deletionProviders() {
    return {
      exchangeAppleAuthorizationCode: vi.fn(async (
        _bindings: Env,
        authorizationCode: string,
      ) => ({
        token: "apple-refresh-token",
        tokenType: "refresh_token" as const,
        identityToken: `token-for-deletion-${authorizationCode.replace("apple-authorization-code-", "")}`,
      })),
      revokeAppleToken: vi.fn(async () => {}),
      deleteSonioxResources: vi.fn(async () => {}),
    };
  }

  async function createDeletionFixtures(
    app: ReturnType<typeof createApp>,
    bindings: Env,
    subject: string,
  ) {
    const owner = await signIn(subject, app, bindings);
    const readyResponse = await createAsset(owner, { filename: `${subject}-ready.mp4` }, bindings);
    const ready = await readyResponse.json<{ asset: { id: string } }>();
    await app.request(`/v1/assets/${ready.asset.id}/upload`, {
      method: "PUT",
      headers: {
        authorization: owner.authorization,
        "content-type": "video/mp4",
        "content-length": "5",
      },
      body: "video",
    }, bindings);
    await app.request(`/v1/assets/${ready.asset.id}/upload/complete`, {
      method: "POST",
      headers: { authorization: owner.authorization },
    }, bindings);
    await env.DB.prepare(
      `UPDATE assets
          SET soniox_file_id = 'soniox-file', soniox_transcription_id = 'soniox-job',
              transcription_status = 'processing'
        WHERE id = ?`,
    ).bind(ready.asset.id).run();

    const multipartResponse = await createAsset(owner, {
      filename: `${subject}-multipart.mp4`,
      byteSize: 6 * 1024 * 1024,
    }, bindings);
    const multipart = await multipartResponse.json<{
      asset: { id: string };
      upload: { mode: string };
    }>();
    expect(multipart.upload.mode).toBe("multipart");

    await env.MEDIA.put(
      `users/${owner.userId}/assets/${ready.asset.id}/thumbnail.jpg`,
      "thumbnail",
    );
    await env.MEDIA.put(
      `users/${owner.userId}/assets/${ready.asset.id}/derivatives/orphan/frame.jpg`,
      "frame",
    );
    await env.MEDIA.put(
      `users/${owner.userId}/orphaned-upload/media`,
      "orphaned",
    );
    await env.DB.prepare(
      `INSERT INTO daily_weather (
        user_id, local_date, symbol_name, temperature_celsius,
        high_temperature_celsius, low_temperature_celsius, recorded_at,
        attribution_legal_url, attribution_light_url, attribution_dark_url, updated_at
      ) VALUES (?, '2026-07-30', 'sun.max', 30, 32, 25, ?,
        'https://weatherkit.apple.com/legal', 'https://example.com/light',
        'https://example.com/dark', ?)`,
    ).bind(owner.userId, NOW.toISOString(), NOW.toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO mcp_tokens (
        id, user_id, name, token_hash, created_at, expires_at
      ) VALUES (?, ?, 'delete-me', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      owner.userId,
      await sha256Hex(`mcp-${subject}`),
      NOW.toISOString(),
      new Date(NOW.getTime() + 60_000).toISOString(),
    ).run();
    const analysisJobId = crypto.randomUUID();
    const derivativeJobId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO daily_summaries (
          user_id, start_at, end_at, source_digest, source_transcript_count,
          source_visual_analysis_count, summary, model, generated_at
        ) VALUES (?, ?, ?, ?, 1, 0, 'delete summary', 'test-qwen', ?)`,
      ).bind(
        owner.userId,
        "2026-07-29T00:00:00.000Z",
        "2026-07-30T00:00:00.000Z",
        "a".repeat(64),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO gpu_jobs (
          id, asset_id, kind, status, request_json, priority, attempt_count,
          available_at, created_at, updated_at
        ) VALUES (?, ?, 'analysis', 'queued', '{}', 0, 0, ?, ?, ?)`,
      ).bind(
        analysisJobId,
        ready.asset.id,
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO video_analyses (
          asset_id, job_id, model_id, model_revision, backend, coverage_mode,
          summary, created_at, updated_at
        ) VALUES (?, ?, 'microsoft/Mage-VL', 'revision', 'frames', 'full',
          'delete analysis', ?, ?)`,
      ).bind(
        ready.asset.id,
        analysisJobId,
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO video_analysis_segments (
          analysis_asset_id, position, start_ms, end_ms, caption
        ) VALUES (?, 0, 0, 1000, 'delete segment')`,
      ).bind(ready.asset.id),
      env.DB.prepare(
        `INSERT INTO gpu_jobs (
          id, asset_id, kind, status, request_json, priority, attempt_count,
          available_at, created_at, updated_at
        ) VALUES (?, ?, 'frame', 'queued', '{}', 0, 0, ?, ?, ?)`,
      ).bind(
        derivativeJobId,
        ready.asset.id,
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO media_derivatives (
          id, asset_id, job_id, kind, start_ms, end_ms, status, object_key,
          content_type, byte_size, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'frame', 0, 0, 'ready', ?, 'image/jpeg', 5, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        ready.asset.id,
        derivativeJobId,
        `users/${owner.userId}/assets/${ready.asset.id}/derivatives/delete/frame.jpg`,
        new Date(NOW.getTime() + 60_000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO ai_consents (
          user_id, version, consented_at, withdrawn_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?)`,
      ).bind(owner.userId, AI_CONSENT_VERSION, NOW.toISOString(), NOW.toISOString()),
      env.DB.prepare(
        `INSERT INTO external_ai_work_leases (
          id, user_id, kind, created_at, expires_at
        ) VALUES (?, ?, 'qwen_summary', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        owner.userId,
        NOW.toISOString(),
        new Date(NOW.getTime() + 60_000).toISOString(),
      ),
    ]);
    return {
      owner,
      readyAssetId: ready.asset.id,
      multipartAssetId: multipart.asset.id,
    };
  }

  it("deletes every owned resource, aborts multipart, and makes receipt replay idempotent", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    const abort = vi.fn();
    const bindings = envWithDeletionMediaHooks({ abort });
    const app = makeDeletionApp(clock, providers);
    const fixtures = await createDeletionFixtures(app, bindings, "deletion-owner");
    const other = await signIn("deletion-other", app, bindings);
    const otherKey = `users/${other.userId}/assets/other/private.mp4`;
    await env.MEDIA.put(otherKey, "other-private");

    const deleted = await app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: fixtures.owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(await accountDeletionCredentials(
        app,
        "deletion-owner",
        "apple-authorization-code-owner",
        bindings,
      )),
    }, bindings);
    expect(deleted.status).toBe(202);
    await expect(deleted.json()).resolves.toEqual({
      deletion: { status: "completed" },
      localSessionShouldBeCleared: true,
    });

    expect(providers.exchangeAppleAuthorizationCode).toHaveBeenCalledOnce();
    expect(providers.revokeAppleToken).toHaveBeenCalledWith(
      bindings,
      "apple-refresh-token",
      "refresh_token",
    );
    expect(providers.deleteSonioxResources).toHaveBeenCalledWith(
      bindings,
      "soniox-job",
      "soniox-file",
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM assets WHERE user_id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id FROM daily_weather WHERE user_id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM mcp_tokens WHERE user_id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id FROM daily_summaries WHERE user_id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM gpu_jobs LIMIT 1").first()).toBeNull();
    expect(await env.DB.prepare("SELECT asset_id FROM video_analyses LIMIT 1").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM media_derivatives LIMIT 1").first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id FROM ai_consents WHERE user_id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id FROM external_ai_work_leases WHERE user_id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
    expect(await env.DB.prepare(
      "SELECT asset_id FROM account_deletion_assets WHERE user_id = ? LIMIT 1",
    ).bind(fixtures.owner.userId).first()).toBeNull();
    expect(await env.DB.prepare(
      `SELECT id FROM account_deletion_jobs
        WHERE user_id = ? OR apple_subject = ?`,
    ).bind(fixtures.owner.userId, "deletion-owner").first()).toBeNull();
    expect(await env.MEDIA.list({
      prefix: `users/${fixtures.owner.userId}/`,
    })).toMatchObject({ objects: [] });
    expect(await env.MEDIA.get(otherKey)).not.toBeNull();

    const replay = await app.request("/v1/account", {
      method: "DELETE",
      headers: { authorization: fixtures.owner.authorization },
    }, bindings);
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toEqual({
      deletion: { status: "completed" },
      localSessionShouldBeCleared: true,
    });
    expect(providers.exchangeAppleAuthorizationCode).toHaveBeenCalledOnce();
    expect(providers.revokeAppleToken).toHaveBeenCalledOnce();
    expect(providers.deleteSonioxResources).toHaveBeenCalledOnce();
  });

  it("fences a stale account-deletion worker after lease takeover", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    let releaseFirstRevocation!: () => void;
    let markFirstRevocationStarted!: () => void;
    const firstRevocationStarted = new Promise<void>((resolve) => {
      markFirstRevocationStarted = resolve;
    });
    const firstRevocationRelease = new Promise<void>((resolve) => {
      releaseFirstRevocation = resolve;
    });
    providers.revokeAppleToken
      .mockImplementationOnce(async () => {
        markFirstRevocationStarted();
        await firstRevocationRelease;
      })
      .mockResolvedValueOnce(undefined);

    const app = makeDeletionApp(clock, providers);
    const fixtures = await createDeletionFixtures(app, env, "deletion-lease-takeover");
    const credentials = await accountDeletionCredentials(
      app,
      "deletion-lease-takeover",
      "apple-authorization-code-lease-takeover",
    );
    const firstRequest = app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: fixtures.owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(credentials),
    }, env);
    await firstRevocationStarted;

    const job = await env.DB.prepare(
      "SELECT id, updated_at FROM account_deletion_jobs WHERE user_id = ?",
    ).bind(fixtures.owner.userId).first<{ id: string; updated_at: string }>();
    expect(job).not.toBeNull();
    clock.value = new Date(new Date(job!.updated_at).getTime() + 6 * 60_000);
    await expect(processPendingAccountDeletions(
      env,
      clock.value,
      providers,
    )).resolves.toEqual({ processed: 1 });
    expect(await env.DB.prepare(
      `SELECT status, last_error_code, owner_token
         FROM account_deletion_jobs WHERE id = ?`,
    ).bind(job!.id).first()).toMatchObject({
      status: "completed",
      last_error_code: null,
      owner_token: null,
    });

    releaseFirstRevocation();
    const firstResponse = await firstRequest;
    expect(firstResponse.status).toBe(202);
    await expect(firstResponse.json()).resolves.toMatchObject({
      deletion: { status: "pending" },
    });
    expect(providers.revokeAppleToken).toHaveBeenCalledTimes(2);
    expect(providers.deleteSonioxResources).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare(
      "SELECT status, owner_token FROM account_deletion_jobs WHERE id = ?",
    ).bind(job!.id).first()).toEqual({ status: "completed", owner_token: null });
    expect(await env.DB.prepare(
      "SELECT id FROM users WHERE id = ?",
    ).bind(fixtures.owner.userId).first()).toBeNull();
  });

  it("waits for an in-flight Soniox lease and refreshes late provider IDs before deletion", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    const app = makeDeletionApp(clock, providers);
    const fixtures = await createDeletionFixtures(app, env, "deletion-soniox-race");
    await env.DB.prepare(
      `UPDATE assets
          SET soniox_file_id = NULL, soniox_transcription_id = NULL
        WHERE id = ?`,
    ).bind(fixtures.readyAssetId).run();
    await env.DB.prepare(
      `INSERT INTO soniox_work_leases (
        asset_id, user_id, owner_token, created_at, expires_at
      ) VALUES (?, ?, 'active-deletion-test', ?, ?)`,
    ).bind(
      fixtures.readyAssetId,
      fixtures.owner.userId,
      NOW.toISOString(),
      new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    ).run();

    const accepted = await app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: fixtures.owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(await accountDeletionCredentials(
        app,
        "deletion-soniox-race",
        "apple-authorization-code-soniox-race",
      )),
    }, env);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({
      deletion: { status: "pending" },
      localSessionShouldBeCleared: true,
    });
    expect(providers.deleteSonioxResources).not.toHaveBeenCalled();
    expect(await env.DB.prepare(
      "SELECT id FROM users WHERE id = ?",
    ).bind(fixtures.owner.userId).first()).not.toBeNull();
    expect(await env.DB.prepare(
      "SELECT withdrawn_at FROM ai_consents WHERE user_id = ?",
    ).bind(fixtures.owner.userId).first()).toMatchObject({
      withdrawn_at: NOW.toISOString(),
    });
    expect(await env.DB.prepare(
      "SELECT deletion_requested_at FROM assets WHERE id = ?",
    ).bind(fixtures.readyAssetId).first()).toMatchObject({
      deletion_requested_at: NOW.toISOString(),
    });

    await env.DB.prepare(
      `UPDATE assets
          SET soniox_file_id = 'late-soniox-file',
              soniox_transcription_id = 'late-soniox-job'
        WHERE id = ?`,
    ).bind(fixtures.readyAssetId).run();
    await env.DB.prepare("DELETE FROM soniox_work_leases WHERE asset_id = ?")
      .bind(fixtures.readyAssetId)
      .run();
    clock.value = new Date(NOW.getTime() + 60_000);

    await expect(processPendingAccountDeletions(
      env,
      clock.value,
      providers,
    )).resolves.toEqual({ processed: 1 });
    expect(providers.deleteSonioxResources).toHaveBeenCalledWith(
      env,
      "late-soniox-job",
      "late-soniox-file",
    );
    expect(await env.DB.prepare(
      "SELECT id FROM users WHERE id = ?",
    ).bind(fixtures.owner.userId).first()).toBeNull();
  });

  it("prunes completed deletion receipts and tombstones after thirty days", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    const app = makeDeletionApp(clock, providers);
    const owner = await signIn("deletion-metadata-retention", app);
    const response = await app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(await accountDeletionCredentials(
        app,
        "deletion-metadata-retention",
        "apple-authorization-code-metadata-retention",
      )),
    }, env);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      deletion: { status: "completed" },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_jobs",
    ).first<{ count: number }>()).toEqual({ count: 1 });

    await cleanupExpiredState(
      env,
      new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1_000),
    );
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_jobs",
    ).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_receipts",
    ).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("accepts only one concurrent account deletion reauthorization", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    const app = makeDeletionApp(clock, providers);
    const owner = await signIn("deletion-concurrent", app);
    const body = JSON.stringify(await accountDeletionCredentials(
      app,
      "deletion-concurrent",
      "apple-authorization-code-concurrent",
    ));
    const deleteRequest = () => app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body,
    }, env);

    const responses = await Promise.all([deleteRequest(), deleteRequest()]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 400]);
    const accepted = responses.find((response) => response.status === 202);
    await expect(accepted?.json<{
      deletion: { status: string };
      localSessionShouldBeCleared: boolean;
    }>()).resolves.toMatchObject({ localSessionShouldBeCleared: true });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_deletion_jobs",
    ).first<{ count: number }>()).toEqual({ count: 1 });
    expect(providers.exchangeAppleAuthorizationCode).toHaveBeenCalledOnce();
    expect(providers.revokeAppleToken).toHaveBeenCalledOnce();
  });

  it("rejects a deletion authorization code for another Apple subject before revoking the session", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    providers.exchangeAppleAuthorizationCode.mockResolvedValueOnce({
      token: "attacker-refresh-token",
      tokenType: "refresh_token",
      identityToken: "token-for-another-apple-subject",
    });
    const app = makeDeletionApp(clock, providers);
    const owner = await signIn("deletion-bound-owner", app);
    const response = await app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(await accountDeletionCredentials(
        app,
        "deletion-bound-owner",
        "apple-authorization-code-bound-owner",
      )),
    }, env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "apple_reauthorization_account_mismatch" },
    });
    expect(await env.DB.prepare("SELECT id FROM sessions WHERE user_id = ?")
      .bind(owner.userId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM account_deletion_jobs WHERE user_id = ?")
      .bind(owner.userId).first()).toBeNull();
    expect(providers.revokeAppleToken).not.toHaveBeenCalled();
  });

  it("keeps deletion intent durable across Apple failure and blocks account resurrection", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    providers.revokeAppleToken
      .mockRejectedValueOnce(new Error("temporary Apple outage"))
      .mockResolvedValueOnce();
    const app = makeDeletionApp(clock, providers);
    const fixtures = await createDeletionFixtures(app, env, "deletion-retry-owner");

    const first = await app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: fixtures.owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(await accountDeletionCredentials(
        app,
        "deletion-retry-owner",
        "apple-authorization-code-retry-owner",
      )),
    }, env);
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({
      deletion: { status: "pending" },
      localSessionShouldBeCleared: true,
    });
    expect(await env.DB.prepare(
      "SELECT status, revocation_token FROM account_deletion_jobs WHERE user_id = ?",
    ).bind(fixtures.owner.userId).first()).toMatchObject({
      status: "pending",
      revocation_token: "apple-refresh-token",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
      .bind(fixtures.owner.userId).first<{ count: number }>()).toMatchObject({ count: 0 });
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(fixtures.owner.userId).first()).not.toBeNull();

    const privateRoute = await app.request("/v1/me", {
      headers: { authorization: fixtures.owner.authorization },
    }, env);
    expect(privateRoute.status).toBe(401);

    const challenge = (await issueChallenge(app, "203.0.113.80")).body;
    const resurrection = await app.request("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        identityToken: "token-for-deletion-retry-owner#fresh-token",
      }),
    }, env);
    expect(resurrection.status).toBe(409);
    await expect(resurrection.json()).resolves.toMatchObject({
      error: { code: "account_deletion_pending" },
    });

    clock.value = new Date(NOW.getTime() + 61_000);
    const retried = await app.request("/v1/account", {
      method: "DELETE",
      headers: { authorization: fixtures.owner.authorization },
    }, env);
    expect(retried.status).toBe(202);
    await expect(retried.json()).resolves.toEqual({
      deletion: { status: "completed" },
      localSessionShouldBeCleared: true,
    });
    expect(providers.exchangeAppleAuthorizationCode).toHaveBeenCalledOnce();
    expect(providers.revokeAppleToken).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
  });

  it("retries a failed multipart abort before completing deletion", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    let abortAttempts = 0;
    const bindings = envWithDeletionMediaHooks({
      beforeAbort: () => {
        abortAttempts += 1;
        if (abortAttempts === 1) throw new Error("temporary multipart outage");
      },
    });
    const app = makeDeletionApp(clock, providers);
    const fixtures = await createDeletionFixtures(
      app,
      bindings,
      "deletion-multipart-retry",
    );

    const first = await app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: fixtures.owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(await accountDeletionCredentials(
        app,
        "deletion-multipart-retry",
        "apple-authorization-code-multipart-retry",
        bindings,
      )),
    }, bindings);
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      deletion: { status: "pending" },
    });
    expect(await env.DB.prepare(
      `SELECT multipart_aborted_at
         FROM account_deletion_assets
        WHERE asset_id = ?`,
    ).bind(fixtures.multipartAssetId).first()).toEqual({
      multipart_aborted_at: null,
    });
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(fixtures.owner.userId).first()).not.toBeNull();

    clock.value = new Date(NOW.getTime() + 61_000);
    const retried = await app.request("/v1/account", {
      method: "DELETE",
      headers: { authorization: fixtures.owner.authorization },
    }, bindings);
    expect(retried.status).toBe(202);
    await expect(retried.json()).resolves.toMatchObject({
      deletion: { status: "completed" },
    });
    expect(abortAttempts).toBe(2);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
  });

  it("retries Soniox and R2 failures without deleting another owner's objects", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    providers.deleteSonioxResources
      .mockRejectedValueOnce(new Error("temporary Soniox outage"))
      .mockResolvedValueOnce();
    let failDelete = true;
    const bindings = envWithDeletionMediaHooks({
      beforeDelete: () => {
        if (failDelete) {
          failDelete = false;
          throw new Error("temporary R2 outage");
        }
      },
    });
    const app = makeDeletionApp(clock, providers);
    const fixtures = await createDeletionFixtures(app, bindings, "deletion-provider-owner");
    const other = await signIn("deletion-provider-other", app, bindings);
    const otherKey = `users/${other.userId}/assets/private/other.mp4`;
    await env.MEDIA.put(otherKey, "other");

    const first = await app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: fixtures.owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(await accountDeletionCredentials(
        app,
        "deletion-provider-owner",
        "apple-authorization-code-provider-owner",
        bindings,
      )),
    }, bindings);
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      deletion: { status: "pending" },
    });
    expect(await env.MEDIA.get(otherKey)).not.toBeNull();

    clock.value = new Date(NOW.getTime() + 61_000);
    const second = await app.request("/v1/account", {
      method: "DELETE",
      headers: { authorization: fixtures.owner.authorization },
    }, bindings);
    expect(second.status).toBe(202);
    const secondBody = await second.json<{ deletion: { status: string } }>();
    if (secondBody.deletion.status === "pending") {
      clock.value = new Date(NOW.getTime() + 6 * 60_000);
      const third = await app.request("/v1/account", {
        method: "DELETE",
        headers: { authorization: fixtures.owner.authorization },
      }, bindings);
      await expect(third.json()).resolves.toMatchObject({
        deletion: { status: "completed" },
      });
    } else {
      expect(secondBody.deletion.status).toBe("completed");
    }
    expect(await env.MEDIA.get(otherKey)).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(fixtures.owner.userId).first()).toBeNull();
  });

  it("requires a fresh Apple authorization code before recording deletion intent", async () => {
    const clock = { value: NOW };
    const providers = deletionProviders();
    const app = makeDeletionApp(clock, providers);
    const owner = await signIn("deletion-code-required", app);
    const response = await app.request("/v1/account", {
      method: "DELETE",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }, env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "apple_reauthorization_required" },
    });
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(owner.userId).first()).not.toBeNull();
    expect((await app.request("/v1/me", {
      headers: { authorization: owner.authorization },
    }, env)).status).toBe(200);
  });
});

describe("abuse and cost quotas", () => {
  it("enforces ten asset creations per rolling 24 hours with a bounded ledger", async () => {
    const owner = await signIn("asset-rate-owner");
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, index) => createAsset(owner, {
        filename: `quota-${index}.mp4`,
      })),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(10);
    const rejected = responses.find((response) => response.status !== 201);
    expect(rejected?.status).toBe(429);
    await expect(rejected!.json()).resolves.toMatchObject({
      error: { code: "asset_creation_quota_exceeded" },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM asset_creation_ledger WHERE user_id = ?",
    ).bind(owner.userId).first<{ count: number }>()).toMatchObject({ count: 10 });
  });

  it("enforces 30 GiB of active declared storage atomically", async () => {
    const owner = await signIn("storage-owner");
    const bindings = {
      ...env,
      MULTIPART_PART_SIZE_BYTES: "104857600",
    } as unknown as Env;
    const first = await createAsset(owner, {
      filename: "thirty-gib.mp4",
      byteSize: 30 * 1024 * 1024 * 1024,
    }, bindings);
    expect(first.status).toBe(201);

    const over = await createAsset(owner, {
      filename: "over.mp4",
      byteSize: 1,
    }, bindings);
    expect(over.status).toBe(429);
    await expect(over.json()).resolves.toMatchObject({
      error: { code: "storage_quota_exceeded" },
    });

    const firstBody = await first.json<{ asset: { id: string } }>();
    await env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = ?")
      .bind(firstBody.asset.id)
      .run();
    const afterFailure = await createAsset(owner, {
      filename: "after-failure.mp4",
      byteSize: 1,
    }, bindings);
    expect(afterFailure.status).toBe(201);
  });

  it("admits only one of two concurrent 20 GiB storage claims", async () => {
    const owner = await signIn("storage-race-owner");
    const bindings = {
      ...env,
      MULTIPART_PART_SIZE_BYTES: "104857600",
    } as unknown as Env;
    const responses = await Promise.all([
      createAsset(owner, {
        filename: "race-a.mp4",
        byteSize: 20 * 1024 * 1024 * 1024,
      }, bindings),
      createAsset(owner, {
        filename: "race-b.mp4",
        byteSize: 20 * 1024 * 1024 * 1024,
      }, bindings),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    const rejected = responses.find((response) => response.status === 429);
    await expect(rejected!.json()).resolves.toMatchObject({
      error: { code: "storage_quota_exceeded" },
    });
    expect(await env.DB.prepare(
      `SELECT SUM(byte_size) AS bytes FROM assets
        WHERE user_id = ? AND status IN ('uploading', 'ready')`,
    ).bind(owner.userId).first<{ bytes: number }>()).toEqual({
      bytes: 20 * 1024 * 1024 * 1024,
    });
  });

  it("caps active Mage and total external-AI work at four per user", async () => {
    const owner = await signIn("ai-work-owner");
    expect((await setConsent(owner, true)).status).toBe(200);
    const assetIds = Array.from({ length: 6 }, () => crypto.randomUUID());
    for (const assetId of assetIds) {
      await env.DB.prepare(
        `INSERT INTO assets (
          id, user_id, kind, filename, content_type, byte_size, captured_at,
          status, object_key, upload_mode, created_at, updated_at, agent_access_enabled
        ) VALUES (?, ?, 'video', ?, 'video/mp4', 5, ?, 'ready', ?, 'single', ?, ?, 0)`,
      ).bind(
        assetId,
        owner.userId,
        `${assetId}.mp4`,
        NOW.toISOString(),
        `users/${owner.userId}/assets/${assetId}/media`,
        NOW.toISOString(),
        NOW.toISOString(),
      ).run();
    }

    for (const assetId of assetIds.slice(0, 4)) {
      const enabled = await owner.app.request(`/v1/assets/${assetId}/agent-access`, {
        method: "PATCH",
        headers: {
          authorization: owner.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }, env);
      expect(enabled.status).toBe(200);
    }
    const mageLimited = await owner.app.request(`/v1/assets/${assetIds[4]}/agent-access`, {
      method: "PATCH",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    }, env);
    expect(mageLimited.status).toBe(429);
    await expect(mageLimited.json()).resolves.toMatchObject({
      error: { code: "analysis_queue_limit" },
    });

    await env.DB.prepare("DELETE FROM gpu_jobs").run();
    await env.DB.prepare("UPDATE assets SET agent_access_enabled = 0").run();
    for (const assetId of assetIds.slice(0, 4)) {
      await env.DB.prepare(
        "UPDATE assets SET transcription_status = 'pending' WHERE id = ?",
      ).bind(assetId).run();
    }
    const externalLimited = await owner.app.request(`/v1/assets/${assetIds[5]}/agent-access`, {
      method: "PATCH",
      headers: {
        authorization: owner.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    }, env);
    expect(externalLimited.status).toBe(429);
    await expect(externalLimited.json()).resolves.toMatchObject({
      error: { code: "external_ai_work_limit" },
    });
  });
});

describe("privacy safety migration", () => {
  it("is re-runnable while preserving users and assets with safe access backfill", async () => {
    const owner = await signIn("migration-owner");
    const assetId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO assets (
        id, user_id, kind, filename, content_type, byte_size, captured_at,
        status, object_key, upload_mode, created_at, updated_at
      ) VALUES (?, ?, 'video', 'migration.mp4', 'video/mp4', 5, ?,
        'ready', ?, 'single', ?, ?)`,
    ).bind(
      assetId,
      owner.userId,
      NOW.toISOString(),
      `users/${owner.userId}/assets/${assetId}/media`,
      NOW.toISOString(),
      NOW.toISOString(),
    ).run();
    await env.DB.prepare("UPDATE assets SET agent_access_enabled = 1 WHERE id = ?")
      .bind(assetId)
      .run();

    const migration = env.TEST_MIGRATIONS.find(
      (candidate) => candidate.name === "0012_privacy_safety.sql",
    );
    expect(migration).toBeDefined();
    for (let pass = 0; pass < 2; pass += 1) {
      for (const query of migration!.queries) {
        await env.DB.prepare(query).run();
      }
    }

    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(owner.userId).first()).toEqual({ id: owner.userId });
    expect(await env.DB.prepare(
      "SELECT id, agent_access_enabled FROM assets WHERE id = ? AND user_id = ?",
    ).bind(assetId, owner.userId).first()).toEqual({
      id: assetId,
      agent_access_enabled: 0,
    });
  });
});
