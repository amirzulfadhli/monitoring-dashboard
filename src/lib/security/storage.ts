/**
 * Persistence for local security monitoring: one row per observation in
 * `security_snapshots`, one lifecycle row per condition in `security_findings`.
 *
 * Same design as the other storage modules: the shared connection opens lazily,
 * every call is wrapped so a failure degrades to a no-op, and nothing here ever
 * throws. The snapshot columns hold small normalized JSON documents — never raw
 * command output and never a process path or command line.
 */

import { getDb } from "@/lib/db";

import type {
  DefenderStatus,
  FirewallStatus,
  PortsStatus,
  SecuritySnapshot,
} from "./model";
import type { FindingChange, SecurityFindingKind, SecuritySeverity } from "./findings";

/* ------------------------------------------------------------------ *
 * Snapshots
 * ------------------------------------------------------------------ */

type SnapshotRow = {
  ts: number;
  platform: string;
  firewall: string;
  defender: string;
  ports: string;
};

function parseColumn<T>(json: string, fallback: T): T {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** A stored snapshot whose columns could not be read reports unavailable. */
function unreadable(reason: string) {
  return { available: false, reason };
}

function toSnapshot(r: SnapshotRow): SecuritySnapshot {
  const firewall = parseColumn<FirewallStatus>(r.firewall, {
    ...unreadable("stored firewall state could not be read"),
    profiles: [],
  });
  const defender = parseColumn<DefenderStatus>(r.defender, {
    ...unreadable("stored Defender state could not be read"),
    amServiceEnabled: null,
    antivirusEnabled: null,
    realtimeEnabled: null,
    signatureAgeDays: null,
    runningMode: null,
  });
  const ports = parseColumn<PortsStatus>(r.ports, {
    ...unreadable("stored port state could not be read"),
    entries: [],
  });
  return {
    collectedAt: r.ts,
    platform: r.platform,
    firewall: { ...firewall, profiles: firewall.profiles ?? [] },
    defender,
    ports: { ...ports, entries: ports.entries ?? [] },
  };
}

/** Persist one observation. Never throws. */
export function persistSecuritySnapshot(s: SecuritySnapshot): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    d.prepare(
      `INSERT OR REPLACE INTO security_snapshots
         (ts, platform, firewall, defender, ports,
          defenderAvailable, defenderRealtimeEnabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.collectedAt,
      s.platform,
      JSON.stringify(s.firewall),
      JSON.stringify(s.defender),
      JSON.stringify(s.ports),
      s.defender.available ? 1 : 0,
      s.defender.realtimeEnabled === true ? 1 : s.defender.realtimeEnabled === false ? 0 : null,
    );
    return true;
  } catch {
    return false;
  }
}

const SNAPSHOT_COLUMNS = `ts, platform, firewall, defender, ports`;

/** The most recent observation, or null when none is stored / readable. */
export function readLatestSecuritySnapshot(): SecuritySnapshot | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS} FROM security_snapshots ORDER BY ts DESC LIMIT 1`,
      )
      .get() as SnapshotRow | undefined;
    return row ? toSnapshot(row) : null;
  } catch {
    return null;
  }
}

/**
 * True when some snapshot *before* `beforeTs` (and within `since`) reported
 * Defender as available. This is what makes the availability rule a transition
 * rather than a standing complaint: a machine that never had Defender (a
 * third-party antivirus) never raises it.
 */
export function defenderAvailableBefore(beforeTs: number, since: number): boolean {
  const d = getDb();
  if (!d) return false;
  try {
    const row = d
      .prepare(
        `SELECT 1 AS present FROM security_snapshots
          WHERE ts < ? AND ts >= ? AND defenderAvailable = 1 LIMIT 1`,
      )
      .get(beforeTs, since) as { present: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

/** A persisted finding condition (also the shape served by the API). */
export type StoredSecurityFinding = {
  fingerprint: string;
  kind: SecurityFindingKind;
  subject: string;
  severity: SecuritySeverity;
  title: string;
  detail: string;
  resolution: string | null;
  status: "active" | "resolved";
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
};

type FindingRow = {
  fingerprint: string;
  kind: string;
  subject: string;
  severity: string;
  title: string;
  detail: string;
  resolution: string | null;
  status: string;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
};

function toFinding(r: FindingRow): StoredSecurityFinding {
  return {
    fingerprint: r.fingerprint,
    kind: r.kind as SecurityFindingKind,
    subject: r.subject,
    severity: r.severity as SecuritySeverity,
    title: r.title,
    detail: r.detail,
    resolution: r.resolution,
    status: r.status === "active" ? "active" : "resolved",
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    resolvedAt: r.resolvedAt,
  };
}

/**
 * Apply one finding verdict, using the same lifecycle as the alert store: an
 * active verdict creates or refreshes the row (firstSeenAt preserved, so a
 * sustained condition never looks like a new occurrence), an inactive verdict
 * for a known-active fingerprint resolves it.
 */
export function applySecurityFinding(change: FindingChange, now: number): void {
  const d = getDb();
  if (!d) return;
  try {
    if (change.active) {
      const row = d
        .prepare(`SELECT status FROM security_findings WHERE fingerprint = ?`)
        .get(change.fingerprint) as { status: string } | undefined;
      if (row?.status === "active") {
        d.prepare(
          `UPDATE security_findings
              SET severity = ?, title = ?, detail = ?, lastSeenAt = ?
            WHERE fingerprint = ?`,
        ).run(change.severity, change.title, change.detail, now, change.fingerprint);
      } else if (row) {
        // Recurrence: reactivate the same row and drop the previous resolution.
        d.prepare(
          `UPDATE security_findings
              SET severity = ?, title = ?, detail = ?, status = 'active',
                  lastSeenAt = ?, resolvedAt = NULL, resolution = NULL
            WHERE fingerprint = ?`,
        ).run(change.severity, change.title, change.detail, now, change.fingerprint);
      } else {
        d.prepare(
          `INSERT INTO security_findings
             (fingerprint, kind, subject, severity, title, detail, resolution,
              status, firstSeenAt, lastSeenAt, resolvedAt)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, NULL)`,
        ).run(
          change.fingerprint,
          change.kind,
          change.subject,
          change.severity,
          change.title,
          change.detail,
          now,
          now,
        );
      }
    } else {
      // The verdict's detail is the observation that closed the condition.
      d.prepare(
        `UPDATE security_findings
            SET status = 'resolved', resolution = ?, resolvedAt = ?, lastSeenAt = ?
          WHERE fingerprint = ? AND status = 'active'`,
      ).run(change.detail, now, now, change.fingerprint);
    }
  } catch {
    // Persistence must never break collection.
  }
}

/** Apply a whole derivation. Never throws. */
export function applySecurityFindings(changes: FindingChange[], now: number): void {
  for (const c of changes) applySecurityFinding(c, now);
}

/** Findings, newest activity first. [] on no data or failure. */
export function readSecurityFindings(): StoredSecurityFinding[] {
  const d = getDb();
  if (!d) return [];
  try {
    const rows = d
      .prepare(`SELECT * FROM security_findings ORDER BY lastSeenAt DESC LIMIT 200`)
      .all() as FindingRow[];
    return rows.map(toFinding);
  } catch {
    return [];
  }
}
