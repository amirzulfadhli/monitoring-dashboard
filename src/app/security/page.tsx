"use client";

import { useEffect, useState } from "react";
import type { SecurityView } from "@/app/api/security/route";
import type {
  CapabilityState,
  PortExposure,
  SecurityPosture,
} from "@/lib/security/model";
import type { StoredSecurityFinding } from "@/lib/security/storage";

// The scheduler owns the collection cadence (~5m); this only controls how often
// the page re-reads the collected state.
const REFRESH_MS = 30_000;

type Tone = "good" | "warn" | "critical" | "muted";

const toneDot: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
  muted: "bg-zinc-300 dark:bg-zinc-600",
};

const postureTone: Record<SecurityPosture, Tone> = {
  protected: "good",
  attention: "warn",
  unknown: "muted",
};

const postureLabel: Record<SecurityPosture, string> = {
  protected: "No protection reported as off",
  attention: "Protection reported as off",
  unknown: "Nothing observed",
};

const severityTone: Record<StoredSecurityFinding["severity"], Tone> = {
  info: "muted",
  warning: "warn",
  critical: "critical",
};

const exposureLabel: Record<PortExposure, string> = {
  any: "all interfaces",
  loopback: "loopback",
  specific: "specific address",
};

function fmtAgo(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A three-state boolean from the platform: true / false / not reported. */
function BoolValue({ value, on, off }: { value: boolean | null; on: string; off: string }) {
  if (value === null) {
    return <span className="text-xs text-zinc-400 dark:text-zinc-500">Not reported</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-200">
      <span className={`h-2 w-2 rounded-full ${toneDot[value ? "good" : "critical"]}`} aria-hidden="true" />
      {value ? on : off}
    </span>
  );
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
      <div className="flex items-baseline justify-between gap-4 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800/60">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
        {hint && <p className="text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>}
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">{children}</div>
    </section>
  );
}

/** One label/value row inside a panel. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/** Why a capability could not be read — shown instead of an invented state. */
function Unavailable({ state }: { state: CapabilityState }) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        {state.reason ?? "Not available"}
      </p>
    </div>
  );
}

export default function SecurityPage() {
  const [data, setData] = useState<SecurityView | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/security", { cache: "no-store" });
        if (res.ok) {
          const d = (await res.json()) as SecurityView;
          if (!cancelled) {
            setData(d);
            setState("ok");
          }
        } else if (!cancelled) {
          setState("error");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  let body: React.ReactNode;
  if (!data && state === "error") {
    body = <Empty message="Security monitoring is unavailable." />;
  } else if (!data) {
    body = <Empty message="Reading local security state…" />;
  } else if (!data.supported) {
    body = (
      <Empty
        message={`Local security monitoring is Windows-only — this host reports platform "${data.platform}".`}
      />
    );
  } else {
    body = <SecurityBody data={data} />;
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Security
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Local firewall, Defender and listening-port observations for this machine.
          </p>
        </div>
        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
          {data?.lastCheckedAt
            ? `Checked ${fmtAgo(data.lastCheckedAt)}`
            : "No observation yet"}
        </span>
      </div>
      {body}
    </div>
  );
}

function SecurityBody({ data }: { data: SecurityView }) {
  const { firewall, defender, ports, findings } = data;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-black">
        <span className={`h-2 w-2 shrink-0 rounded-full ${toneDot[postureTone[data.posture]]}`} aria-hidden="true" />
        <span className="text-sm text-zinc-700 dark:text-zinc-200">
          {postureLabel[data.posture]}
        </span>
        <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500">
          Reported by the machine itself, not a score
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel
          title="Windows Firewall"
          hint={firewall.available ? `${firewall.profiles.length} profiles` : undefined}
        >
          {!firewall.available ? (
            <Unavailable state={firewall} />
          ) : (
            firewall.profiles.map((p) => (
              <Row key={p.name} label={p.name}>
                <span className="inline-flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-200">
                  <span
                    className={`h-2 w-2 rounded-full ${toneDot[p.enabled ? "good" : "critical"]}`}
                    aria-hidden="true"
                  />
                  {p.enabled ? "Enabled" : "Disabled"}
                </span>
              </Row>
            ))
          )}
        </Panel>

        <Panel title="Microsoft Defender">
          {!defender.available ? (
            <Unavailable state={defender} />
          ) : (
            <>
              <Row label="Antivirus service">
                <BoolValue value={defender.amServiceEnabled} on="Enabled" off="Disabled" />
              </Row>
              <Row label="Antivirus protection">
                <BoolValue value={defender.antivirusEnabled} on="Enabled" off="Disabled" />
              </Row>
              <Row label="Real-time protection">
                <BoolValue value={defender.realtimeEnabled} on="Enabled" off="Disabled" />
              </Row>
              <Row label="Signature age">
                <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
                  {defender.signatureAgeDays != null
                    ? `${defender.signatureAgeDays}d`
                    : "–"}
                </span>
              </Row>
              <Row label="Running mode">
                <span className="text-xs text-zinc-600 dark:text-zinc-300">
                  {defender.runningMode ?? "–"}
                </span>
              </Row>
            </>
          )}
        </Panel>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
        <div className="flex items-baseline justify-between gap-4 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800/60">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Listening ports
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            {ports.available ? `${ports.entries.length} TCP sockets` : "Not available"}
          </p>
        </div>
        {!ports.available ? (
          <Unavailable state={ports} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                  <th className="px-4 py-2 font-medium">Port</th>
                  <th className="px-4 py-2 font-medium">Address</th>
                  <th className="px-4 py-2 font-medium">Reach</th>
                  <th className="px-4 py-2 font-medium">Process</th>
                  <th className="px-4 py-2 font-medium">PID</th>
                </tr>
              </thead>
              <tbody>
                {ports.entries.map((p) => (
                  <tr
                    key={`${p.address}:${p.port}`}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                  >
                    <td className="px-4 py-2 font-mono text-xs tabular-nums text-zinc-800 dark:text-zinc-100">
                      {p.port}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {p.address}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                      {exposureLabel[p.exposure]}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-600 dark:text-zinc-300">
                      {p.process ?? "–"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs tabular-nums text-zinc-400 dark:text-zinc-500">
                      {p.pid ?? "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Panel
        title="Findings"
        hint={
          findings.active.length > 0
            ? `${findings.active.length} active`
            : "Nothing active"
        }
      >
        {findings.active.length === 0 && findings.recent.length === 0 ? (
          <div className="px-4 py-3">
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              No security findings observed yet.
            </p>
          </div>
        ) : (
          <>
            {findings.active.map((f) => (
              <FindingRow key={f.fingerprint} finding={f} />
            ))}
            {findings.recent.map((f) => (
              <FindingRow key={f.fingerprint} finding={f} resolved />
            ))}
          </>
        )}
      </Panel>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Read-only local queries (Windows Firewall profile state, Defender status, TCP listeners).
        DevPulse never probes a port, scans a host, inspects traffic or changes any system setting —
        an open port is reported as an observation, not as a threat. Findings change only when the
        observed state changes.
      </p>
    </div>
  );
}

function FindingRow({
  finding,
  resolved = false,
}: {
  finding: StoredSecurityFinding;
  resolved?: boolean;
}) {
  const when = resolved ? finding.resolvedAt : finding.firstSeenAt;
  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5">
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneDot[resolved ? "muted" : severityTone[finding.severity]]}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-zinc-800 dark:text-zinc-100">
          {finding.title}
          <span className="ml-2 font-mono text-[11px] font-normal text-zinc-400 dark:text-zinc-500">
            {finding.subject}
          </span>
        </p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {resolved ? (finding.resolution ?? finding.detail) : finding.detail}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {when && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500" title={fmtTime(when)}>
            {fmtAgo(when)}
          </p>
        )}
        {resolved && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">resolved</p>
        )}
      </div>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white px-6 text-center text-sm text-zinc-400 dark:border-zinc-800 dark:bg-black dark:text-zinc-500">
      {message}
    </div>
  );
}
