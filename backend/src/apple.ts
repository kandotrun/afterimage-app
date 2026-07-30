import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from "jose";
import { z } from "zod";

export interface AppleIdentity {
  subject: string;
  email?: string;
  displayName?: string;
}

const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const appleTokenResponseSchema = z.object({
  refresh_token: z.string().min(1).max(16_384).optional(),
  access_token: z.string().min(1).max(16_384).optional(),
});

async function appleClientSecret(bindings: Env): Promise<string> {
  if (!bindings.APPLE_TEAM_ID || !bindings.APPLE_KEY_ID || !bindings.APPLE_PRIVATE_KEY) {
    throw new Error("Apple revocation is not configured");
  }
  const key = await importPKCS8(
    bindings.APPLE_PRIVATE_KEY.replaceAll("\\n", "\n"),
    "ES256",
  );
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: bindings.APPLE_KEY_ID })
    .setIssuer(bindings.APPLE_TEAM_ID)
    .setAudience("https://appleid.apple.com")
    .setSubject(bindings.APPLE_BUNDLE_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

export async function exchangeAppleAuthorizationCode(
  bindings: Env,
  authorizationCode: string,
): Promise<{ token: string; tokenType: "refresh_token" | "access_token" }> {
  const body = new URLSearchParams({
    client_id: bindings.APPLE_BUNDLE_ID,
    client_secret: await appleClientSecret(bindings),
    code: authorizationCode,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Apple authorization code exchange failed");
  const parsed = appleTokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Apple authorization code exchange response is invalid");
  if (parsed.data.refresh_token) {
    return { token: parsed.data.refresh_token, tokenType: "refresh_token" };
  }
  if (parsed.data.access_token) {
    return { token: parsed.data.access_token, tokenType: "access_token" };
  }
  throw new Error("Apple authorization code exchange returned no revocable token");
}

export async function revokeAppleToken(
  bindings: Env,
  token: string,
  tokenType: "refresh_token" | "access_token",
): Promise<void> {
  const body = new URLSearchParams({
    client_id: bindings.APPLE_BUNDLE_ID,
    client_secret: await appleClientSecret(bindings),
    token,
    token_type_hint: tokenType,
  });
  const response = await fetch("https://appleid.apple.com/auth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Apple token revocation failed");
}

export async function verifyAppleIdentityToken(
  identityToken: string,
  audience: string,
  expectedNonce: string,
): Promise<AppleIdentity> {
  const { payload } = await jwtVerify(identityToken, appleJwks, {
    issuer: "https://appleid.apple.com",
    audience,
    requiredClaims: ["sub", "exp", "nonce"],
  });
  if (!payload.sub) throw new Error("apple identity token has no subject");
  if (payload.nonce !== expectedNonce) throw new Error("apple identity token nonce mismatch");
  return {
    subject: payload.sub,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
  };
}
