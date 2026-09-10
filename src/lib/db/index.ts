/**
 * The canonical DevPulse database connection.
 *
 * Every storage module used to open its own `DatabaseSync` against the same file
 * and create the schema itself. There is now exactly one connection, opened
 * lazily on first use and cached on `globalThis` so Next's dev-mode module
 * reloading and the background scheduler share it instead of each adding a new
 * handle to the same file.
 *
 * Failure policy is unchanged from the modules this replaces: if the database
 * cannot be opened or migrated, `getDb()` returns null and the caller degrades to
 * a no-op. Storage problems must never break live telemetry or monitoring. An
 * explicitly configured path (DEVPULSE_DB_PATH / DEVPULSE_DB_DIR) that fails is
 * never silently replaced by another location.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDbPath } from "./path";
import { migrate } from "./schema";

export { DB_FILE_NAME, DEFAULT_DB_DIR, resolveDbPath } from "./path";
export { SCHEMA_VERSION } from "./schema";

type DbHolder = { db: DatabaseSync | null; path: string | null };

const GLOBAL_KEY = "__devpulseDb";

function holder(): DbHolder {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: DbHolder };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { db: null, path: null };
  return g[GLOBAL_KEY];
}

/**
 * The shared database handle, or null when storage is unavailable. Opens and
 * migrates on first call; subsequent calls return the cached connection.
 */
export function getDb(): DatabaseSync | null {
  const dbPath = resolveDbPath();
  const h = holder();
  if (h.db && h.path === dbPath) return h.db;

  try {
    // A previously opened connection for a different path (scratch/isolated
    // verification switching DEVPULSE_DB_PATH) is released first.
    if (h.db) {
      try {
        h.db.close();
      } catch {
        // Already closed or busy; the new connection below is what matters.
      }
      h.db = null;
      h.path = null;
    }

    mkdirSync(path.dirname(dbPath), { recursive: true });
    const d = new DatabaseSync(dbPath);
    migrate(d);
    h.db = d;
    h.path = dbPath;
    return d;
  } catch {
    return null;
  }
}

/** Close the shared connection (used by scripts/verification). Never throws. */
export function closeDb(): void {
  const h = holder();
  try {
    h.db?.close();
  } catch {
    // Ignore: closing an already-unusable handle is not an error worth surfacing.
  }
  h.db = null;
  h.path = null;
}
