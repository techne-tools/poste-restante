/**
 * Regenerate the age interop fixtures — one-off, run by hand, never in CI.
 *
 *   npx tsx server/test/fixtures/age/regenerate.ts
 *
 * Why a script rather than a checked-in blob plus a README of commands: the
 * fixture only has evidential value if the bytes it contains came from a
 * *different* implementation than the one under test. A script that refuses to
 * run without the reference CLI makes that hard to do by accident on a machine
 * where only the JS port is installed.
 *
 * What it produces, and why both directions:
 *   reference.age — sealed by filippo.io/age (the Go reference implementation,
 *                   https://github.com/FiloSottile/age). The test asserts this
 *                   port can read it. Frozen bytes: a port regression in
 *                   decryption or in header parsing shows up here and nowhere
 *                   else in the suite.
 *   port.age      — sealed by this repo's own `sealToRecipients`. The test
 *                   asserts it still decrypts, and — when the reference CLI is
 *                   present — that the reference decrypts it too.
 *
 * The identity is a fixture key. It guards nothing but the files in this
 * directory, and it is committed on purpose: the test needs it. Never reuse it
 * for a real letter.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { identityToRecipient } from "age-encryption";
import { sealToRecipients, unsealWithIdentity } from "../../../src/crypto/keys.js";

const here = dirname(fileURLToPath(import.meta.url));
const path = (name: string) => join(here, name);

/** The first non-comment, non-empty line — how every age tool reads a key file. */
function firstKeyLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (!line) throw new Error("no key line in file");
  return line;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The reference CLI, or a refusal. Regenerating without it would turn the
 *  fixture into a self-consistency test wearing a provenance hat. */
function ageCli(args: string[], input?: string): Buffer {
  try {
    return execFileSync("age", args, { cwd: here, ...(input ? { input } : {}) });
  } catch (err) {
    throw new Error(
      `the reference implementation (filippo.io/age, https://github.com/FiloSottile/age) ` +
        `is not usable via \`age\`: ${(err as Error).message}. Install it (brew install age / ` +
        `go install filippo.io/age/cmd/age@latest) — do NOT regenerate this fixture with the JS port alone.`,
    );
  }
}

function installedPortVersion(): string {
  let dir = here;
  for (;;) {
    const candidate = join(dir, "node_modules", "age-encryption", "package.json");
    if (existsSync(candidate)) {
      return (JSON.parse(readFileSync(candidate, "utf8")) as { version: string }).version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("age-encryption is not installed; run npm ci first");
    dir = parent;
  }
}

const identity = firstKeyLine(readFileSync(path("identity.txt"), "utf8"));
const recipient = firstKeyLine(readFileSync(path("recipient.txt"), "utf8"));
const plaintext = readFileSync(path("plaintext.txt"), "utf8");

// The identity and the recipient must be a pair, or every fixture below would
// be testing the wrong sentence.
if ((await identityToRecipient(identity)) !== recipient) {
  throw new Error("identity.txt and recipient.txt are not a pair — regenerate both");
}

// 1. Reference direction: the Go implementation seals, we will read.
const referenceBytes = ageCli(["-r", recipient, "-a", "plaintext.txt"]);
writeFileSync(path("reference.age"), referenceBytes);

// 2. Ours: this port seals, the reference will read.
writeFileSync(path("port.age"), await sealToRecipients(plaintext, [recipient]));

// 3. Prove both directions now, before anything is recorded as good.
const weReadTheirs = await unsealWithIdentity(readFileSync(path("reference.age"), "utf8"), identity);
if (weReadTheirs !== plaintext) {
  throw new Error("this port could not read the reference ciphertext — fixture NOT updated");
}
const theyReadOurs = ageCli(["-d", "-i", "identity.txt", "port.age"]).toString("utf8");
if (theyReadOurs !== plaintext) {
  throw new Error("the reference could not read this port's ciphertext — fixture NOT updated");
}

const manifest = {
  // Full timestamp, UTC — the fixture is regenerated on machines in other
  // timezones, so a bare local date would be ambiguous.
  generated_utc: new Date().toISOString(),
  spec: "C2SP age v1 — wire format `age-encryption.org/v1`, X25519 recipient stanza",
  recipient,
  reference: {
    implementation: "filippo.io/age (https://github.com/FiloSottile/age)",
    version: ageCli(["--version"]).toString("utf8").trim(),
    command: `age -r ${recipient} -a plaintext.txt > reference.age`,
    file: "reference.age",
    sha256: sha256(path("reference.age")),
  },
  port: {
    package: "age-encryption",
    version: installedPortVersion(),
    command: "sealToRecipients(plaintext, [recipient]) — server/src/crypto/keys.ts",
    file: "port.age",
    sha256: sha256(path("port.age")),
    verified_by: "age -d -i identity.txt port.age",
  },
};
writeFileSync(path("manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log("both directions verified:");
console.log("  port  ← reference.age   ok");
console.log("  age   ← port.age        ok");
console.log(JSON.stringify(manifest, null, 2));
