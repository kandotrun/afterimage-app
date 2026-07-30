export const AI_CONSENT_VERSION = "2026-07-30";
export const DERIVED_DATA_RETENTION = "retained_until_asset_or_account_deletion";

export interface AiConsentRow {
  version: string;
  consented_at: string | null;
  withdrawn_at: string | null;
}

export async function findAiConsent(
  bindings: Env,
  userId: string,
): Promise<AiConsentRow | null> {
  return bindings.DB.prepare(
    `SELECT version, consented_at, withdrawn_at
       FROM ai_consents
      WHERE user_id = ?`,
  ).bind(userId).first<AiConsentRow>();
}

export function isActiveAiConsent(row: AiConsentRow | null): boolean {
  return row?.version === AI_CONSENT_VERSION
    && row.consented_at !== null
    && row.withdrawn_at === null;
}

export async function hasActiveAiConsent(
  bindings: Env,
  userId: string,
): Promise<boolean> {
  const row = await bindings.DB.prepare(
    `SELECT 1 AS active
       FROM ai_consents
      WHERE user_id = ? AND version = ?
        AND consented_at IS NOT NULL AND withdrawn_at IS NULL`,
  ).bind(userId, AI_CONSENT_VERSION).first<{ active: number }>();
  return row?.active === 1;
}

export function aiConsentJson(row: AiConsentRow | null) {
  return {
    consent: {
      version: AI_CONSENT_VERSION,
      consentedAt: row?.consented_at ?? null,
      withdrawnAt: row?.withdrawn_at ?? null,
      active: isActiveAiConsent(row),
    },
    derivedDataRetention: DERIVED_DATA_RETENTION,
  };
}
