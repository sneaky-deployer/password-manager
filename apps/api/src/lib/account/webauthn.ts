// Passkeys as a second factor (PLAN.md 10.6) through @simplewebauthn/server. The RP ID is the
// app's hostname (never the parent domain) and the expected origin is the exact APP_ORIGIN.
import type { WebauthnAssertion, WebauthnRegistrationCredential } from "@pm/shared";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { WebauthnCredential } from "../../db/schema.ts";
import type { Config } from "../../env.ts";
import { base64urlDecode, base64urlEncode } from "../crypto.ts";

const RP_NAME = "Password Manager";

function parseTransports(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function descriptor(row: Pick<WebauthnCredential, "credentialId" | "transports">) {
  const transports = parseTransports(row.transports);
  return transports.length > 0 ? { id: row.credentialId, transports } : { id: row.credentialId };
}

export function registrationOptions(
  config: Config,
  user: { id: string; email: string },
  existing: Pick<WebauthnCredential, "credentialId" | "transports">[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: config.rpId,
    userName: user.email,
    userDisplayName: user.email,
    // The user handle is the (non-secret) account id, so the same account always maps to it.
    userID: new Uint8Array(new TextEncoder().encode(user.id)),
    attestationType: "none",
    excludeCredentials: existing.map(descriptor),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

/** Returns null when the attestation does not verify (bad challenge, origin, RP ID, format). */
export async function verifyRegistration(
  config: Config,
  credential: WebauthnRegistrationCredential,
  expectedChallenge: string,
): Promise<VerifiedRegistration | null> {
  try {
    const result = await verifyRegistrationResponse({
      // The library validates the structure in depth; the API schema keeps unknown members.
      response: credential as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: false,
    });
    if (!result.verified) return null;
    const { credential: registered } = result.registrationInfo;
    return {
      credentialId: registered.id,
      publicKey: base64urlEncode(registered.publicKey),
      counter: registered.counter,
      transports: (registered.transports as string[] | undefined) ?? [],
    };
  } catch {
    return null;
  }
}

export function authenticationOptions(
  config: Config,
  credentials: Pick<WebauthnCredential, "credentialId" | "transports">[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: credentials.map(descriptor),
    userVerification: "preferred",
  });
}

/**
 * Verifies a login assertion against a stored credential. Returns the new signature counter, or
 * null when it does not verify. `expectedChallenge` is the one issued by `/auth/webauthn/options`.
 */
export async function verifyAssertion(
  config: Config,
  stored: WebauthnCredential,
  assertion: WebauthnAssertion,
  expectedChallenge: string,
): Promise<number | null> {
  try {
    const result = await verifyAuthenticationResponse({
      response: assertion as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: false,
      credential: {
        id: stored.credentialId,
        publicKey: base64urlDecode(stored.publicKey),
        counter: stored.counter,
        transports: parseTransports(stored.transports) as WebauthnCredentialTransports,
      },
    });
    return result.verified ? result.authenticationInfo.newCounter : null;
  } catch {
    return null;
  }
}

type WebauthnCredentialTransports = NonNullable<
  Parameters<typeof verifyAuthenticationResponse>[0]["credential"]["transports"]
>;
