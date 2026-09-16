import { ensureSchedulerStarted } from "@/lib/scheduler";
import { getLatestSecurity } from "@/lib/scheduler/store";
import { getSecurityResults } from "@/lib/security";
import {
  derivePosture,
  type DefenderStatus,
  type FirewallStatus,
  type ListeningPort,
  type PortsStatus,
  type SecurityPosture,
} from "@/lib/security/model";
import {
  readLatestSecuritySnapshot,
  readSecurityFindings,
  type StoredSecurityFinding,
} from "@/lib/security/storage";

// Server-only monitor; never statically pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How far back a resolved finding is still listed as recent. */
const RECENT_FINDING_MS = 86_400_000;
const MAX_RECENT_FINDINGS = 12;

export type SecurityFindingsView = {
  /** Conditions observed right now. */
  active: StoredSecurityFinding[];
  /** Conditions that cleared within the last 24h. */
  recent: StoredSecurityFinding[];
};

/** The read-only shape served to the Security page. */
export type SecurityView = {
  generatedAt: number;
  /** False on a non-Windows host: reported instead of collecting nothing. */
  supported: boolean;
  platform: string;
  lastCheckedAt: number | null;
  posture: SecurityPosture;
  firewall: FirewallStatus;
  defender: DefenderStatus;
  ports: PortsStatus;
  findings: SecurityFindingsView;
};

/** The honest "nothing was observed" view, used for both failure modes. */
function unobserved(
  reason: string,
  base: Pick<SecurityView, "generatedAt" | "supported" | "platform" | "findings">,
): SecurityView {
  return {
    ...base,
    lastCheckedAt: null,
    posture: "unknown",
    firewall: { available: false, reason, profiles: [] },
    defender: {
      available: false,
      reason,
      amServiceEnabled: null,
      antivirusEnabled: null,
      realtimeEnabled: null,
      signatureAgeDays: null,
      runningMode: null,
    },
    ports: { available: false, reason, entries: [] as ListeningPort[] },
  };
}

/**
 * GET /api/security — the latest local security observation plus recent
 * findings.
 *
 * Nothing here scans, probes or changes anything: the response is built from the
 * stored snapshot, with the same cold-start fallback the other monitors use for
 * the window before the first scheduled collection. On a non-Windows host the
 * route reports `supported: false` rather than pretending to have observed a
 * machine it cannot read.
 */
export async function GET() {
  try {
    ensureSchedulerStarted();
    const generatedAt = Date.now();
    const supported = process.platform === "win32";

    const all = readSecurityFindings();
    const findings: SecurityFindingsView = {
      active: all.filter((f) => f.status === "active"),
      recent: all
        .filter(
          (f) =>
            f.status === "resolved" &&
            f.resolvedAt != null &&
            f.resolvedAt >= generatedAt - RECENT_FINDING_MS,
        )
        .slice(0, MAX_RECENT_FINDINGS),
    };
    const base = { generatedAt, supported, platform: process.platform, findings };

    if (!supported) {
      return Response.json(
        unobserved(
          `local security monitoring is Windows-only (platform: ${process.platform})`,
          base,
        ) satisfies SecurityView,
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Scheduler-collected snapshot first; the collector is a cold-start
    // fallback, and the stored row is the last resort if that run fails.
    let snapshot = getLatestSecurity()?.value ?? null;
    if (!snapshot) {
      try {
        snapshot = await getSecurityResults();
      } catch {
        snapshot = readLatestSecuritySnapshot();
      }
    }
    if (!snapshot) {
      return Response.json(
        unobserved("no local security observation is available yet", base) satisfies SecurityView,
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      {
        generatedAt,
        supported,
        platform: snapshot.platform,
        lastCheckedAt: snapshot.collectedAt,
        posture: derivePosture(snapshot),
        firewall: snapshot.firewall,
        defender: snapshot.defender,
        ports: snapshot.ports,
        findings,
      } satisfies SecurityView,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "security_unavailable" }, { status: 503 });
  }
}
