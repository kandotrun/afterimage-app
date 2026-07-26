import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AppleIdentity {
  subject: string;
  email?: string;
  displayName?: string;
}

const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

export async function verifyAppleIdentityToken(
  identityToken: string,
  audience: string,
): Promise<AppleIdentity> {
  const { payload } = await jwtVerify(identityToken, appleJwks, {
    issuer: "https://appleid.apple.com",
    audience,
  });
  if (!payload.sub) throw new Error("apple identity token has no subject");
  return {
    subject: payload.sub,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
  };
}
