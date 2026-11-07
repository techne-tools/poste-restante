/**
 * age interop — the test that proves this port speaks the same wire format as
 * everything else in the age ecosystem, not merely to itself.
 *
 * Every other crypto test in this repo (`crypto-keys.test.ts`) seals and unseals
 * with the same library, so a port bug that both writes and reads a malformed
 * header passes all of them. This file is the one place where a second
 * implementation is in the loop: `server/test/fixtures/age/` holds ciphertext
 * produced by filippo.io/age (the Go reference implementation) and ciphertext
 * produced by this port that the reference decrypted.
 *
 * The spec being tested is C2SP `age` v1 — header line `age-encryption.org/v1`,
 * `-> X25519 <arg>` recipient stanza (recorded in `crypto/keys.ts`'s header, and
 * in the fixture manifest).
 *
 * What runs where:
 *   * always      — the port decrypts the reference's ciphertext (the highest-
 *                   value assertion in the suite: it fails if the pinned
 *                   `age-encryption` build changes header parsing or stanza
 *                   handling in a way that orphans stored letters);
 *   * always      — the frozen port fixture still decrypts, and both fixtures
 *                   carry the age v1 header;
 *   * when `age` is on PATH — the reference decrypts the frozen port fixture
 *                   and a ciphertext this build seals right now. The CI workflow
 *                   installs no reference binary, so there these skip; the
 *                   fixture was generated and verified with one (see
 *                   `manifest.json` and `regenerate.ts`). A skip here is not a
 *                   pass.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { armor, identityToRecipient } from "age-encryption";
import { describe, it, expect } from "vitest";
import { generateAgeIdentity, sealToRecipients, unsealWithIdentity } from "../../src/crypto/keys.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures", "age");
const repoRoot = join(here, "..", "..", "..");

/** The first non-comment, non-empty line — how every age tool reads a key file. */
function firstKeyLine(name: string): string {
  const line = readFileSync(join(fixtures, name), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) throw new Error(`${name} carries no key line`);
  return line;
}

const identity = firstKeyLine("identity.txt");
const recipient = firstKeyLine("recipient.txt");
const plaintext = readFileSync(join(fixtures, "plaintext.txt"), "utf8");
const referenceCiphertext = readFileSync(join(fixtures, "reference.age"), "utf8");
const portCiphertext = readFileSync(join(fixtures, "port.age"), "utf8");

interface FixtureManifest {
  generated_utc: string;
  spec: string;
  recipient: string;
  reference: { implementation: string; version: string; command: string; sha256: string };
  port: { package: string; version: string; sha256: string; verified_by: string };
}
const manifest = JSON.parse(readFileSync(join(fixtures, "manifest.json"), "utf8")) as FixtureManifest;

/** The installed copy of the dependency — the version the tests actually ran against. */
function installedAgeEncryption(): { version: string } {
  let dir = repoRoot;
  for (;;) {
    const candidate = join(dir, "node_modules", "age-encryption", "package.json");
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8")) as { version: string };
    const parent = dirname(dir);
    if (parent === dir) throw new Error("age-encryption is not installed — run npm ci");
    dir = parent;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

/** The reference implementation, if this machine has one. */
const hasReference = spawnSync("age", ["--version"], { encoding: "utf8" }).status === 0;

/** The raw header of an armoured age file — version line and stanzas. */
function headerOf(armoured: string): string {
  const raw = armor.decode(armoured);
  const header = Buffer.from(raw.subarray(0, 200)).toString("utf8");
  return header.slice(0, header.indexOf("---") + 3);
}

describe("the age dependency is pinned, and the pin is the one the fixtures prove", () => {
  const workspaces = ["server", "client"] as const;

  it.each(workspaces)("%s/package.json pins age-encryption exactly, with no range", (workspace) => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, workspace, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const spec = pkg.dependencies["age-encryption"];
    // A caret here is a supply-chain surface: this library produces every stored
    // ciphertext, so a minor bump that changes header behaviour would make old
    // letters unreadable rather than fail loudly at write time.
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("both workspaces pin the same version, and it is the installed one", () => {
    const specs = workspaces.map((w) => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, w, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      return pkg.dependencies["age-encryption"];
    });
    expect(specs[0]).toBe(specs[1]);
    expect(specs[0]).toBe(installedAgeEncryption().version);
  });

  it("the lockfile keeps the resolved tarball and its integrity digest", () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const entry = lock.packages["node_modules/age-encryption"];
    expect(entry?.version).toBe(installedAgeEncryption().version);
    expect(entry?.integrity).toMatch(/^sha512-/);
  });

  it("the fixture records which build produced it, and the spec it claims", () => {
    // A pin bump is meant to be a deliberate act with a fixture regeneration in
    // it: the fixture is the interop evidence for the build in use, so a stale
    // manifest is a sign the upgrade was never proved. If this assertion is the
    // one that failed, run `npx tsx server/test/fixtures/age/regenerate.ts` with
    // the reference `age` CLI installed, and read the diff.
    expect(
      manifest.port.version,
      "the fixture predates the pinned age-encryption version — regenerate it before committing the bump",
    ).toBe(installedAgeEncryption().version);
    expect(manifest.spec).toContain("age-encryption.org/v1");
    expect(manifest.reference.implementation).toContain("filippo.io/age");
  });

  it("crypto/keys.ts's header names the wire format it implements", () => {
    // The pin records a library; the spec records a format. A future reader
    // asking "compatible with what?" must find the answer where the sealing
    // code lives, not only in this test.
    const source = readFileSync(join(repoRoot, "server", "src", "crypto", "keys.ts"), "utf8");
    expect(source).toContain("age-encryption.org/v1");
    expect(source).toContain("C2SP");
  });
});

describe("the fixture is the bytes the reference produced, not bytes this port made", () => {
  it("reference.age and port.age match their recorded digests", () => {
    // Without this, a contributor without the Go toolchain could "regenerate"
    // the fixture with this port and quietly turn the interop test into another
    // round-trip test. Regenerate with test/fixtures/age/regenerate.ts instead.
    expect(sha256(referenceCiphertext)).toBe(manifest.reference.sha256);
    expect(sha256(portCiphertext)).toBe(manifest.port.sha256);
  });

  it("the identity and the recipient in the fixture are a pair", async () => {
    expect(await identityToRecipient(identity)).toBe(recipient);
    expect(manifest.recipient).toBe(recipient);
  });

  it.each([
    ["reference.age", referenceCiphertext],
    ["port.age", portCiphertext],
  ])("%s carries the C2SP age v1 header and an X25519 stanza", (_name, armoured) => {
    const header = headerOf(armoured);
    expect(header.split("\n")[0]).toBe("age-encryption.org/v1");
    expect(header).toMatch(/\n-> X25519 [A-Za-z0-9+/]{43}\n/);
  });
});

describe("interop: the two implementations read each other", () => {
  it("this port decrypts a ciphertext sealed by filippo.io/age", async () => {
    // The assertion this whole file exists for. It fails if the pinned
    // age-encryption build stops parsing the age v1 header or the X25519
    // stanza — i.e. if every sealed letter already in the database would
    // become unreadable.
    expect(await unsealWithIdentity(referenceCiphertext, identity)).toBe(plaintext);
  });

  it("the frozen ciphertext this port sealed still decrypts", async () => {
    expect(await unsealWithIdentity(portCiphertext, identity)).toBe(plaintext);
  });

  it("a different identity cannot open the reference ciphertext", async () => {
    const stranger = await generateAgeIdentity();
    expect(await unsealWithIdentity(referenceCiphertext, stranger)).toBeNull();
  });

  it("a tampered reference ciphertext does not decrypt", async () => {
    const lines = referenceCiphertext.trimEnd().split("\n");
    const body = lines[2];
    if (body === undefined) throw new Error("reference.age has no body line");
    // Flip one base64 character in the MAC line: structurally valid, wrong bytes.
    const at = Math.floor(body.length / 2);
    const swapped = body[at] === "A" ? "B" : "A";
    lines[2] = body.slice(0, at) + swapped + body.slice(at + 1);
    expect(await unsealWithIdentity(lines.join("\n"), identity)).toBeNull();
  });
});

describe.skipIf(!hasReference)("interop: filippo.io/age reads what this port writes", () => {
  // Skipped in CI (no reference binary there). Locally this re-proves what the
  // fixture records, and proves it for the build in use right now.
  it("the reference decrypts the frozen port fixture", () => {
    const out = decryptWithReference(portCiphertext);
    expect(out).toBe(plaintext);
  });

  it("the reference decrypts a ciphertext this build seals now", async () => {
    const fresh = await sealToRecipients(plaintext, [recipient]);
    expect(fresh).not.toBe(portCiphertext); // randomised: same format, new bytes
    expect(decryptWithReference(fresh)).toBe(plaintext);
  });
});

/** Run the reference CLI over an armoured ciphertext, in a scratch dir. */
function decryptWithReference(armoured: string): string {
  const dir = mkdtempSync(join(tmpdir(), "age-interop-"));
  try {
    writeFileSync(join(dir, "ciphertext.age"), armoured);
    writeFileSync(join(dir, "identity.txt"), identity + "\n");
    const result = spawnSync(
      "age",
      ["-d", "-i", join(dir, "identity.txt"), join(dir, "ciphertext.age")],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`age -d failed: ${result.stderr}`);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
