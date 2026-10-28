// A software WebAuthn authenticator (ES256, "none" attestation) so the tests can drive the real
// registration and assertion verification of @simplewebauthn/server inside workerd.
import { base64urlDecode, base64urlEncode } from "../src/lib/crypto.ts";

const encoder = new TextEncoder();

// --- Minimal CBOR (only what attestation objects and COSE keys need) -----------------------------

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value < 256) return [(major << 5) | 24, value];
  return [(major << 5) | 25, value >> 8, value & 0xff];
}

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function cbor(value: Cbor): number[] {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  const out = head(5, value.size);
  for (const [k, v] of value) out.push(...cbor(k), ...cbor(v));
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
}

/** WebCrypto gives r||s; WebAuthn wants an ASN.1 DER ECDSA signature. */
function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let trimmed = bytes.slice(i);
    if ((trimmed[0] as number) & 0x80) trimmed = concat(new Uint8Array([0]), trimmed);
    return concat(new Uint8Array([0x02, trimmed.length]), trimmed);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

export class VirtualAuthenticator {
  readonly credentialId: string;
  private counter = 0;
  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly publicJwk: JsonWebKey,
    private readonly rpId: string,
    private readonly origin: string,
    credentialIdBytes: Uint8Array,
  ) {
    this.credentialId = base64urlEncode(credentialIdBytes);
  }

  static async create(origin: string): Promise<VirtualAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    return new VirtualAuthenticator(
      keys,
      jwk,
      new URL(origin).hostname,
      origin,
      crypto.getRandomValues(new Uint8Array(32)),
    );
  }

  private async clientData(type: string, challenge: string, origin = this.origin) {
    return encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** `RegistrationResponseJSON` for the options issued by `/me/2fa/webauthn/register/options`. */
  async register(challenge: string, origin = this.origin) {
    const credentialId = base64urlDecode(this.credentialId);
    const x = base64urlDecode(this.publicJwk.x as string);
    const y = base64urlDecode(this.publicJwk.y as string);
    const cose = new Uint8Array(
      cbor(
        new Map<Cbor, Cbor>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, x],
          [-3, y],
        ]),
      ),
    );
    const idLength = new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]);
    const authData = concat(
      await sha256(encoder.encode(this.rpId)),
      new Uint8Array([0x45]), // user present + user verified + attested credential data
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array(16), // AAGUID
      idLength,
      credentialId,
      cose,
    );
    const attestationObject = new Uint8Array(
      cbor(
        new Map<Cbor, Cbor>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      ),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: base64urlEncode(
          await this.clientData("webauthn.create", challenge, origin),
        ),
        attestationObject: base64urlEncode(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** `AuthenticationResponseJSON` for the options issued by `/auth/webauthn/options`. */
  async assert(challenge: string, origin = this.origin) {
    this.counter += 1;
    const authData = concat(
      await sha256(encoder.encode(this.rpId)),
      new Uint8Array([0x05]), // user present + user verified
      new Uint8Array([
        (this.counter >>> 24) & 0xff,
        (this.counter >>> 16) & 0xff,
        (this.counter >>> 8) & 0xff,
        this.counter & 0xff,
      ]),
    );
    const clientDataJSON = await this.clientData("webauthn.get", challenge, origin);
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: base64urlEncode(clientDataJSON),
        authenticatorData: base64urlEncode(authData),
        signature: base64urlEncode(derSignature(raw)),
      },
      clientExtensionResults: {},
    };
  }
}
