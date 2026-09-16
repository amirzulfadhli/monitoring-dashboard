/**
 * Deterministic security findings: pure logic over two consecutive
 * observations. No AI, no heuristics, no network, no OS access — the collector
 * feeds real snapshots in and tests feed fixtures in.
 *
 * A finding is a *condition with a lifecycle*, not a log line: it becomes active
 * when the condition is first observed and resolves when it is no longer
 * present. That is what keeps an unchanged snapshot from emitting a new
 * transition every collection, and it is why the same condition is never
 * recorded twice.
 *
 * Neutrality: an open port is reported as an observation, never as a threat. A
 * listening socket is a normal fact about a running machine; nothing here
 * judges whether a port *should* be open.
 */

import type {
  ListeningPort,
  SecuritySnapshot,
} from "./model";

export type SecuritySeverity = "info" | "warning" | "critical";

export type SecurityFindingKind =
  | "firewall_disabled"
  | "defender_disabled"
  | "defender_realtime_disabled"
  | "port_open";

/** One finding verdict for the current observation. */
export type FindingChange = {
  fingerprint: string; // stable identity: security:kind:subject
  kind: SecurityFindingKind;
  subject: string;
  severity: SecuritySeverity;
  /** Names the condition; used for both activation and resolution events. */
  title: string;
  /**
   * Active: what was observed. Inactive: why the condition cleared (stored as
   * the finding's resolution so History can explain the closure).
   */
  detail: string;
  active: boolean;
};

/** Identity of one listening socket, matching the port normalization key. */
const portKey = (p: { address: string; port: number }) => `${p.address}|${p.port}`;

/**
 * Compare the previous observation's sockets with the current one. The first
 * observation of a machine is a baseline, not a change: callers pass `null` and
 * every socket is simply recorded as already-present (see below).
 */
export function diffPorts(
  previous: ListeningPort[],
  current: ListeningPort[],
): { opened: ListeningPort[]; closed: ListeningPort[] } {
  const prevByKey = new Map(previous.map((p) => [portKey(p), p]));
  const curByKey = new Map(current.map((p) => [portKey(p), p]));
  return {
    opened: current.filter((p) => !prevByKey.has(portKey(p))),
    closed: previous.filter((p) => !curByKey.has(portKey(p))),
  };
}

/** Owner suffix for a port description: "(node, pid 1234)" / "(node)" / "". */
function ownerSuffix(p: ListeningPort): string {
  if (!p.process) return "";
  return ` (${p.process}${p.pid != null ? `, pid ${p.pid}` : ""})`;
}

const portFingerprint = (p: ListeningPort) => `security:port_open:${portKey(p)}`;

function portTitle(p: ListeningPort): string {
  return `Listening port ${p.port}`;
}

function portOpenedDetail(p: ListeningPort): string {
  return `TCP ${p.port} is now listening on ${p.address}${ownerSuffix(p)}.`;
}

function portClosedDetail(p: ListeningPort): string {
  return `TCP ${p.port} is no longer listening on ${p.address}.`;
}

/**
 * Derive every finding verdict for the current observation.
 *
 * `previous` is the last persisted snapshot, or null when this is the first one.
 * With no previous observation the listening sockets establish a baseline: no
 * "new port" finding is invented for a machine DevPulse has simply never seen
 * before. Firewall and Defender findings are *current state*, so they are
 * reported from the very first observation.
 *
 * Consequence of that baseline: a socket already listening when DevPulse first
 * observed the machine has no condition row, so only its later *disappearance*
 * goes unreported (a socket that opens afterwards is tracked normally). The
 * alternative — announcing every pre-existing listener as "new" — would be a
 * fabricated claim, which is worse than the gap.
 */
export function deriveSecurityFindings(input: {
  previous: SecuritySnapshot | null;
  current: SecuritySnapshot;
}): FindingChange[] {
  const { previous, current } = input;
  const out: FindingChange[] = [];

  // ---- firewall (one condition per profile, whenever it is reported) ----
  if (current.firewall.available) {
    for (const profile of current.firewall.profiles) {
      const disabled = !profile.enabled;
      out.push({
        fingerprint: `security:firewall_disabled:${profile.name}`,
        kind: "firewall_disabled",
        subject: `${profile.name} profile`,
        severity: "critical",
        title: `Windows Firewall · ${profile.name} profile`,
        detail: disabled
          ? `The ${profile.name} firewall profile is disabled.`
          : `The ${profile.name} firewall profile is enabled.`,
        active: disabled,
      });
    }
  }

  // ---- Defender (only when the platform actually reported a status) ----
  if (current.defender.available) {
    const d = current.defender;
    const off: string[] = [];
    if (d.amServiceEnabled === false) off.push("the antivirus service is disabled");
    if (d.antivirusEnabled === false) off.push("antivirus protection is disabled");
    const disabled = off.length > 0;
    // The platform's own mode string, when reported, explains *why* protection
    // reads as off (e.g. "Not running", "Passive Mode").
    const mode = d.runningMode ? ` (${d.runningMode.toLowerCase()})` : "";
    out.push({
      fingerprint: "security:defender_disabled",
      kind: "defender_disabled",
      subject: "Defender antivirus",
      severity: "critical",
      title: "Windows Defender · antivirus",
      detail: disabled
        ? `Microsoft Defender reports ${off.join(" and ")}${mode}.`
        : "Microsoft Defender reports antivirus protection enabled.",
      active: disabled,
    });

    const realtimeOff = d.realtimeEnabled === false;
    out.push({
      fingerprint: "security:defender_realtime_disabled",
      kind: "defender_realtime_disabled",
      subject: "Defender real-time protection",
      severity: "warning",
      title: "Windows Defender · real-time protection",
      detail: realtimeOff
        ? "Microsoft Defender reports real-time protection disabled."
        : "Microsoft Defender reports real-time protection enabled.",
      active: realtimeOff,
    });
  }

  // ---- listening ports (changes only; the first observation is a baseline) ----
  const previousPorts = previous?.ports.available ? previous.ports.entries : null;
  if (current.ports.available && previousPorts) {
    const { opened, closed } = diffPorts(previousPorts, current.ports.entries);
    for (const p of opened) {
      out.push({
        fingerprint: portFingerprint(p),
        kind: "port_open",
        subject: portKey(p),
        severity: "info",
        title: portTitle(p),
        detail: portOpenedDetail(p),
        active: true,
      });
    }
    for (const p of closed) {
      out.push({
        fingerprint: portFingerprint(p),
        kind: "port_open",
        subject: portKey(p),
        severity: "info",
        title: portTitle(p),
        detail: portClosedDetail(p),
        active: false,
      });
    }
  }

  return out;
}
