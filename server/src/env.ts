/**
 * Local environment.
 *
 * `server/.env` is honoured when present, using Node's own loader — no
 * dependency, no parser to drift. A variable already set in the process wins:
 * a shell export or a supervisor's environment is never overridden by a file
 * on disk, so deployment can always override development.
 *
 * `.env.example` has always told the operator to copy it to `.env`; until
 * 2026-11-08 nothing read the result.
 */

/** Load `path` into process.env if it exists. Returns whether it loaded. */
export function loadDotEnv(path = ".env"): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    // No file, or no permission — either way the process falls back to the
    // environment it was given. Never fatal: the house has working defaults.
    return false;
  }
}
