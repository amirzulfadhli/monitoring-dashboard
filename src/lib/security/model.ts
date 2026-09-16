/**
 * Local security monitoring model.
 *
 * DevPulse observes a small set of *local* Windows security facts and reports
 * them verbatim: firewall profile state, Microsoft Defender status and the
 * machine's own TCP listening sockets. It is deliberately not an IDS, a
 * vulnerability scanner or an offensive tool — nothing here probes a port,
 * inspects a packet, escalates privilege, terminates a process or changes any
 * system configuration. Every collector command is a read-only query.
 *
 * Everything in this file is pure and dependency-free (no OS access, no DB, no
 * scheduler) so the normalization and posture rules can be exercised directly
 * by tests and reused by the API/UI layer.
 *
 * Privacy: only a process *name* (never a path or command line) is kept per
 * listening port, and no raw command output is ever stored or served.
 */

/** How one capability probe went. `reason` is a short, safe explanation. */
export type CapabilityState = {
  available: boolean;
  reason: string | null;
};

export type FirewallProfile = { name: string; enabled: boolean };

export type FirewallStatus = CapabilityState & { profiles: FirewallProfile[] };

/**
 * Defender status as reported by the platform. Each field is nullable because
 * "not reported" and "reported false" are different facts: a missing value must
 * never be presented as a disabled protection (see parseDefender).
 */
export type DefenderStatus = CapabilityState & {
  amServiceEnabled: boolean | null;
  antivirusEnabled: boolean | null;
  realtimeEnabled: boolean | null;
  signatureAgeDays: number | null;
  /**
   * The platform's own mode string (e.g. "Normal", "Passive Mode",
   * "Not running"). Reported verbatim so a machine where Defender is not the
   * active antivirus reads clearly instead of looking like unexplained
   * false flags.
   */
  runningMode: string | null;
};

/** How widely a listening socket is bound. A neutral, observable fact. */
export type PortExposure = "any" | "loopback" | "specific";

/** One normalized TCP listening socket. */
export type ListeningPort = {
  address: string;
  port: number;
  exposure: PortExposure;
  /** Owning process id when the platform reported a usable one. */
  pid: number | null;
  /** Process *name* only — never a path or command line. */
  process: string | null;
};

export type PortsStatus = CapabilityState & { entries: ListeningPort[] };

/** One complete observation of local security state. */
export type SecuritySnapshot = {
  collectedAt: number; // epoch ms
  platform: string;
  firewall: FirewallStatus;
  defender: DefenderStatus;
  ports: PortsStatus;
};

/**
 * The overall observed state, derived only from what was actually observed.
 * Deliberately not a "score": there is no weighting, no invented threshold and
 * no number a user could mistake for a measurement.
 *
 *   attention — some observed protection reports itself as off
 *   unknown   — nothing observable (no capability could be read)
 *   protected — otherwise
 */
export type SecurityPosture = "protected" | "attention" | "unknown";

/** Posture rules, in precedence order. Pure function of observed facts. */
export function derivePosture(
  snapshot: Pick<SecuritySnapshot, "firewall" | "defender">,
): SecurityPosture {
  const { firewall, defender } = snapshot;
  const firewallOff =
    firewall.available && firewall.profiles.some((p) => !p.enabled);
  const defenderOff =
    defender.available &&
    (defender.amServiceEnabled === false ||
      defender.antivirusEnabled === false ||
      defender.realtimeEnabled === false);

  if (firewallOff || defenderOff) return "attention";
  if (!firewall.available && !defender.available) return "unknown";
  return "protected";
}

/** True when no capability could be read at all. */
export function allCapabilitiesUnavailable(s: SecuritySnapshot): boolean {
  return !s.firewall.available && !s.defender.available && !s.ports.available;
}

/* ------------------------------------------------------------------ *
 * Port normalization
 * ------------------------------------------------------------------ */

/** Max length kept for a process name; anything longer is truncated. */
export const MAX_PROCESS_NAME_LENGTH = 64;

/**
 * Normalize a reported address: lowercased, trimmed, IPv6 zone index removed
 * (a link-local `%12` scope suffix is not part of the address itself).
 */
export function normalizeAddress(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  let a = raw.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone > 0) a = a.slice(0, zone);
  return a || "unknown";
}

/** Classify a normalized address by how widely it is reachable. */
export function exposureOf(address: string): PortExposure {
  if (address === "0.0.0.0" || address === "::" || address === "*") return "any";
  if (address === "::1" || address.startsWith("127.")) return "loopback";
  return "specific";
}

/**
 * Reduce a reported process name to a short, safe label.
 *
 * Only the last path segment is kept and only up to the first whitespace: a
 * process *name* is a single token, so anything beyond it (a directory path, an
 * argument list, an entire command line) is not part of the name and is
 * dropped rather than stored. Any remaining punctuation outside the name
 * charset is removed as well, and the result is length-capped.
 */
export function sanitizeProcessName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lastSegment = raw.trim().split(/[\\/]/).pop() ?? "";
  const firstToken = lastSegment.split(/\s+/)[0] ?? "";
  const cleaned = firstToken
    .slice(0, MAX_PROCESS_NAME_LENGTH)
    .replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned || null;
}

/** Raw shape as reported by the platform; every field is untrusted. */
export type RawListeningPort = {
  address?: unknown;
  port?: unknown;
  pid?: unknown;
  process?: unknown;
};

function toPort(raw: RawListeningPort): ListeningPort | null {
  const port = Number(raw?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const address = normalizeAddress(raw?.address);
  const pidNum = Number(raw?.pid);
  return {
    address,
    port,
    exposure: exposureOf(address),
    pid: Number.isInteger(pidNum) && pidNum > 0 ? pidNum : null,
    process: sanitizeProcessName(raw?.process),
  };
}

/**
 * Normalize and deduplicate reported sockets.
 *
 * One socket is identified by address + port (a port bound on both `::` and
 * `0.0.0.0` is reported twice by the platform, and several processes can share
 * a listening port). Duplicates collapse to a single entry that prefers the one
 * carrying process metadata. Output is deterministically ordered by port, then
 * address, so two observations of the same machine compare equal.
 */
export function normalizePorts(raw: unknown): ListeningPort[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, ListeningPort>();
  for (const item of raw as RawListeningPort[]) {
    const p = toPort(item ?? {});
    if (!p) continue;
    const key = `${p.address}|${p.port}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, p);
    } else if (!existing.process && p.process) {
      byKey.set(key, p);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.port - b.port || a.address.localeCompare(b.address),
  );
}
