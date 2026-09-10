import { getDb } from "@/lib/db";
import { DAY_MS } from "./config";
import type {
  AlertCounts,
  AlertRecord,
  AlertSource,
  RuleId,
  RuleVerdict,
  Severity,
  Status,
} from "./model";

/**
 * Persistence for alerts. Lives in the same on-disk SQLite database as
 * telemetry and monitoring histories, but in its own `alerts` table so the two
 * never mix. One row per fingerprint keeps a persistent condition from
 * duplicating into a new alert every evaluation cycle.
 */

type Row = {
  fingerprint: string;
  source: string;
  ruleId: string;
  severity: string;
  title: string;
  message: string;
  status: string;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  metadata: string | null;
};

function toRecord(r: Row): AlertRecord {
  let metadata: AlertRecord["metadata"] = {};
  try {
    metadata = r.metadata ? JSON.parse(r.metadata) : {};
  } catch {
    metadata = {};
  }
  return {
    fingerprint: r.fingerprint,
    source: r.source as AlertSource,
    ruleId: r.ruleId as RuleId,
    severity: r.severity as Severity,
    title: r.title,
    message: r.message,
    status: r.status as Status,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    resolvedAt: r.resolvedAt,
    metadata,
  };
}

/** Apply one verdict: activate (create or refresh) or resolve. Never throws. */
export function applyVerdict(v: RuleVerdict, now: number): void {
  const d = getDb();
  if (!d) return;
  try {
    const meta = JSON.stringify(v.metadata ?? {});
    if (v.active) {
      const row = d
        .prepare(`SELECT status FROM alerts WHERE fingerprint = ?`)
        .get(v.fingerprint) as { status: string } | undefined;
      if (row?.status === "active") {
        // Refresh the live alert; firstSeenAt is preserved so a sustained
        // condition never looks like a new occurrence.
        d.prepare(
          `UPDATE alerts
              SET severity = ?, title = ?, message = ?, lastSeenAt = ?, metadata = ?
            WHERE fingerprint = ?`,
        ).run(v.severity, v.title, v.message, now, meta, v.fingerprint);
      } else if (row) {
        // Recurrence after a previous resolution: reactivate the same
        // occurrence (one row per fingerprint). firstSeenAt is preserved; the
        // row returns to active and leaves the resolved set.
        d.prepare(
          `UPDATE alerts
              SET severity = ?, title = ?, message = ?, status = 'active',
                  lastSeenAt = ?, resolvedAt = NULL, metadata = ?
            WHERE fingerprint = ?`,
        ).run(v.severity, v.title, v.message, now, meta, v.fingerprint);
      } else {
        d.prepare(
          `INSERT INTO alerts
             (fingerprint, source, ruleId, severity, title, message, status,
              firstSeenAt, lastSeenAt, resolvedAt, metadata)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?)`,
        ).run(
          v.fingerprint,
          v.source,
          v.ruleId,
          v.severity,
          v.title,
          v.message,
          now,
          now,
          meta,
        );
      }
    } else {
      // Healthy verdict for a known active fingerprint -> resolve it.
      d.prepare(
        `UPDATE alerts
            SET status = 'resolved', resolvedAt = ?, lastSeenAt = ?
          WHERE fingerprint = ? AND status = 'active'`,
      ).run(now, now, v.fingerprint);
    }
  } catch {
    // Persistence must never break evaluation or degrade the page hard.
  }
}

export type AlertQueryStatus = "active" | "resolved" | "all";

/** Read alerts, optionally filtered by status, newest-last-seen first. */
export function readAlerts(status: AlertQueryStatus): AlertRecord[] {
  const d = getDb();
  if (!d) return [];
  try {
    const rows = (
      status === "all"
        ? d
            .prepare(
              `SELECT * FROM alerts ORDER BY lastSeenAt DESC LIMIT 200`,
            )
            .all()
        : d
            .prepare(
              `SELECT * FROM alerts WHERE status = ? ORDER BY lastSeenAt DESC LIMIT 200`,
            )
            .all(status)
    ) as Row[];
    return rows.map(toRecord);
  } catch {
    return [];
  }
}

/** Derive the summary counts served by the API and Overview indicator. */
export function readCounts(now: number): AlertCounts {
  const d = getDb();
  const empty: AlertCounts = {
    active: 0,
    critical: 0,
    warning: 0,
    info: 0,
    resolvedRecent: 0,
  };
  if (!d) return empty;
  try {
    const act = d
      .prepare(
        `SELECT severity, COUNT(*) AS n FROM alerts WHERE status = 'active' GROUP BY severity`,
      )
      .all() as { severity: string; n: number }[];
    const counts = { ...empty };
    for (const a of act) {
      counts.active += a.n;
      if (a.severity === "critical") counts.critical += a.n;
      else if (a.severity === "warning") counts.warning += a.n;
      else if (a.severity === "info") counts.info += a.n;
    }
    const recent = d
      .prepare(
        `SELECT COUNT(*) AS n FROM alerts WHERE status = 'resolved' AND resolvedAt >= ?`,
      )
      .get(now - DAY_MS) as { n: number };
    counts.resolvedRecent = recent?.n ?? 0;
    return counts;
  } catch {
    return empty;
  }
}
