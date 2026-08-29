/**
 * Structured logger. The house is observable via logs that stay local — no
 * telemetry, no analytics, no phone-home. Logs are the only signal.
 */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** A logger that writes JSON lines to stdout/stderr. */
export function createLogger(): Logger {
  const write = (level: string, event: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, event, ...fields, ts: new Date().toISOString() });
    if (level === "error") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

/**
 * A logger that writes everything to stderr. Required for protocol faces
 * that own stdout — the MCP server speaks JSON-RPC on stdout, so any log
 * line there would corrupt the protocol. Logs stay local; they never
 * phone home.
 */
export function createStderrLogger(): Logger {
  const write = (level: string, event: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, event, ...fields, ts: new Date().toISOString() });
    process.stderr.write(line + "\n");
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

/** A silent logger for tests. */
export function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
