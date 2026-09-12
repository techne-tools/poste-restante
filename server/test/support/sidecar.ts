/**
 * The mailbox sidecar probe — a small support helper for the integration
 * suites that need a live Stalwart dev sidecar (imap-writer, mailbox-drive).
 *
 * The sidecar is an external dependency beyond postgres/qdrant/ollama: it
 * runs on the Docker homelab host, not on every machine that runs
 * `POSTE_RESTANTE_INTEGRATION=1`. When it is absent, those suites skip
 * cleanly rather than failing on an unrelated dependency — the same
 * fail-closed posture the house itself keeps.
 */
import { createConnection } from "node:net";

/** True when something is listening at the IMAP URL's host:port. */
export async function sidecarUp(url: string, timeoutMs = 750): Promise<boolean> {
  let host = "127.0.0.1";
  let port = 143;
  try {
    const parsed = new URL(url);
    host = parsed.hostname || host;
    const fromUrl = parsed.port ? Number(parsed.port) : NaN;
    port = Number.isFinite(fromUrl) ? fromUrl : parsed.protocol === "imaps:" ? 993 : 143;
  } catch {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
