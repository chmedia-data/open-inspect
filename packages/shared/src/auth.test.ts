import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePemPrivateKey } from "./auth";

describe("parsePemPrivateKey", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const der = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));

  it("decodes a key with real newlines", () => {
    expect(parsePemPrivateKey(pem)).toEqual(der);
  });

  it("decodes a key stored on one line with literal \\n sequences", () => {
    const oneLine = pem.trimEnd().replace(/\n/g, "\\n");
    expect(oneLine).not.toContain("\n");
    expect(parsePemPrivateKey(oneLine)).toEqual(der);
  });

  it("yields a key Web Crypto imports from the one-line form", async () => {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      parsePemPrivateKey(pem.replace(/\n/g, "\\n")),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    expect(key.type).toBe("private");
  });
});
