/**
 * Canonical resolution of the DevPulse SQLite file. Every storage module used to
 * derive this itself (with slightly different env handling); this is now the only
 * place the path is computed.
 *
 * Precedence:
 *   1. DEVPULSE_DB_PATH — the exact database file
 *   2. DEVPULSE_DB_DIR  — <dir>/telemetry.db
 *   3. default          — <process.cwd()>/.devpulse/telemetry.db
 *
 * An explicitly configured path is never silently swapped for another one: if the
 * chosen location cannot be opened the caller degrades to a no-op (see getDb).
 */

import path from "node:path";

/** The database file name; DEVPULSE_DB_DIR and the default both append it. */
export const DB_FILE_NAME = "telemetry.db";

/** Default directory, relative to the process working directory. */
export const DEFAULT_DB_DIR = ".devpulse";

function envValue(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

/** The database file DevPulse should use, as an absolute path. */
export function resolveDbPath(): string {
  const explicitFile = envValue("DEVPULSE_DB_PATH");
  if (explicitFile) return path.resolve(explicitFile);

  const explicitDir = envValue("DEVPULSE_DB_DIR");
  if (explicitDir) return path.join(path.resolve(explicitDir), DB_FILE_NAME);

  return path.join(process.cwd(), DEFAULT_DB_DIR, DB_FILE_NAME);
}
