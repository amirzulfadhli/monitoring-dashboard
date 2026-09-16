"use client";

import { useEffect, useState } from "react";
import type {
  ApiMethod,
  MonitoredApi,
  MonitoredDevice,
  MonitoredRepository,
  MonitoredWebsite,
} from "@/lib/settings/types";
import { API_METHODS } from "@/lib/settings/types";
import { DEVICE_TYPES, type DeviceType } from "@/lib/devices/model";

/**
 * Settings page. Configures what DevPulse monitors and how it alerts. All
 * mutations go through the narrow server-side settings API (validated there);
 * this page only renders forms and surfaces success/error feedback. Secrets are
 * never handled here — integrations are status-only.
 */

type Notice = { kind: "error" | "success"; text: string } | null;

type Bundle = {
  websites: MonitoredWebsite[];
  apis: MonitoredApi[];
  repositories: MonitoredRepository[];
  devices: MonitoredDevice[];
  alerts: {
    system: { cpuWarnPct: number; cpuCritPct: number; memWarnPct: number; memCritPct: number };
    ai: { tokenBudget24h: number | null; costBudget24hUsd: number | null };
  };
  integrations: { github: boolean; deepseek: boolean };
};

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-black dark:text-zinc-100";
const btnCls =
  "rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800/60";
const btnPrimary =
  "rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const labelCls =
  "block pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500";

function jsonFetch(url: string, method: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  }).then((r) => r.json());
}

async function api(path: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const j = (await jsonFetch(`/api/settings/${path}`, method, body)) as {
    ok: boolean;
    error?: string;
  };
  return { ok: !!j.ok, error: j.error };
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Fetch the full settings bundle. Pure fetch — no component state here. */
async function fetchBundle(): Promise<Bundle> {
  const res = await fetch("/api/settings", { cache: "no-store" });
  if (!res.ok) throw new Error("settings_unavailable");
  return (await res.json()) as Bundle;
}

export default function SettingsPage() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Initial load; state only updates in promise callbacks (never synchronously
  // in the effect body).
  useEffect(() => {
    let cancelled = false;
    fetchBundle()
      .then((b) => {
        if (cancelled) return;
        setBundle(b);
        setError(false);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-fetch after a mutation succeeds.
  const reload = () => {
    fetchBundle()
      .then((b) => {
        setBundle(b);
        setError(false);
      })
      .catch(() => setError(true));
  };

  if (loading) return <Shell><p className="text-sm text-zinc-500 dark:text-zinc-400">Loading settings…</p></Shell>;
  if (error || !bundle) return <Shell><p className="text-sm text-zinc-500 dark:text-zinc-400">Settings are unavailable.</p></Shell>;

  return (
    <Shell>
      {notice && (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === "error"
              ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
          }`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      <Section title="Sources" subtitle="What DevPulse monitors. Removed sources keep their historical data.">
        <div className="space-y-8">
          <WebsitesSection sites={bundle.websites} onChanged={reload} setNotice={setNotice} />
          <ApisSection apis={bundle.apis} onChanged={reload} setNotice={setNotice} />
          <ReposSection repos={bundle.repositories} onChanged={reload} setNotice={setNotice} />
          <DevicesSection devices={bundle.devices} onChanged={reload} setNotice={setNotice} />
        </div>
      </Section>

      <Section title="Alerts" subtitle="System CPU/memory thresholds used by the alert engine.">
        <SystemThresholds system={bundle.alerts.system} onChanged={reload} setNotice={setNotice} />
      </Section>

      <Section title="AI budgets" subtitle="Optional 24h budgets. Disabled means no limit is enforced.">
        <AiBudgets ai={bundle.alerts.ai} onChanged={reload} setNotice={setNotice} />
      </Section>

      <Section title="Integrations" subtitle="Credentials are configured via .env.local / environment variables — never stored or edited here.">
        <IntegrationsStatus github={bundle.integrations.github} deepseek={bundle.integrations.deepseek} />
      </Section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Settings</h1>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          Monitoring sources and alert thresholds, persisted locally.
        </p>
      </div>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared small controls
 * ------------------------------------------------------------------ */

function RowControls({ onEdit, onRemove }: { onEdit: () => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={onEdit} className={btnCls}>Edit</button>
      <button type="button" onClick={onRemove} className="text-sm text-red-600 hover:underline dark:text-red-400">Remove</button>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-zinc-300 accent-zinc-900 dark:accent-zinc-100"
      />
      {label && <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Websites
 * ------------------------------------------------------------------ */

function WebsitesSection({
  sites,
  onChanged,
  setNotice,
}: {
  sites: MonitoredWebsite[];
  onChanged: () => void;
  setNotice: (n: Notice) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [expected, setExpected] = useState("");

  const report = async (res: { ok: boolean; error?: string }, okText: string) => {
    if (res.ok) {
      setNotice({ kind: "success", text: okText });
      onChanged();
    } else {
      setNotice({ kind: "error", text: res.error ?? "Request failed." });
    }
  };

  const add = async () => {
    const body: Record<string, string | number> = { name, url };
    if (expected.trim() !== "") body.expectedStatus = Number(expected);
    const res = await api("websites", "POST", body);
    if (res.ok) {
      setName("");
      setUrl("");
      setExpected("");
      setAdding(false);
    }
    await report(res, "Website added.");
  };

  const update = async (id: string, patch: Record<string, unknown>) => {
    const res = await api("websites", "PUT", { id, ...patch });
    await report(res, "Website updated.");
  };

  const remove = async (id: string) => {
    const res = await api(`websites?id=${encodeURIComponent(id)}`, "DELETE");
    await report(res, "Website removed. Its history is kept.");
  };

  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Websites</h3>
      <div className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-900">
        {sites.length === 0 && <p className="py-2 text-sm text-zinc-400 dark:text-zinc-500">No websites monitored.</p>}
        {sites.map((s) => (
          <WebsiteRow
            key={s.id}
            site={s}
            onToggle={(v) => update(s.id, { enabled: v })}
            onUpdate={(patch) => update(s.id, patch)}
            onRemove={() => remove(s.id)}
          />
        ))}
      </div>

      {adding ? (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800 md:grid-cols-[1fr_1.4fr_1fr_auto_auto]">
          <div>
            <label className={labelCls}>Name</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Production API" />
          </div>
          <div>
            <label className={labelCls}>URL</label>
            <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com" />
          </div>
          <div>
            <label className={labelCls}>Expected status</label>
            <input className={inputCls} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="200" inputMode="numeric" />
          </div>
          <div className="flex items-end gap-2">
            <button type="button" onClick={add} className={btnPrimary}>Add</button>
            <button type="button" onClick={() => setAdding(false)} className={btnCls}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`${btnPrimary} mt-3`}>
          + Add website
        </button>
      )}
    </div>
  );
}

function WebsiteRow({
  site,
  onToggle,
  onUpdate,
  onRemove,
}: {
  site: MonitoredWebsite;
  onToggle: (v: boolean) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(site.name);
  const [url, setUrl] = useState(site.url);
  const [expected, setExpected] = useState(site.expectedStatus != null ? String(site.expectedStatus) : "");

  const save = () => {
    const patch: Record<string, unknown> = { name, url };
    patch.expectedStatus = expected.trim() === "" ? null : Number(expected);
    onUpdate(patch);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="grid grid-cols-1 gap-3 py-3 md:grid-cols-[1fr_1.4fr_1fr_auto_auto]">
        <div><label className={labelCls}>Name</label><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className={labelCls}>URL</label><input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} /></div>
        <div><label className={labelCls}>Expected status</label><input className={inputCls} value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
        <div className="flex items-end gap-2">
          <button type="button" onClick={save} className={btnPrimary}>Save</button>
          <button type="button" onClick={() => setEditing(false)} className={btnCls}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">{site.name}</p>
          {!site.enabled && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">off</span>}
        </div>
        <p className="truncate font-mono text-xs text-zinc-400 dark:text-zinc-500">{site.url}</p>
        {site.expectedStatus != null && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">expects HTTP {site.expectedStatus}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Toggle checked={site.enabled} onChange={onToggle} label="Enabled" />
        <RowControls onEdit={() => setEditing(true)} onRemove={onRemove} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * API endpoints
 *
 * Same shape as websites, plus a method and a bounded timeout. No request
 * bodies, headers or credentials exist in this configuration at all.
 * ------------------------------------------------------------------ */

const methodCls = `${inputCls} font-mono`;

function ApisSection({
  apis,
  onChanged,
  setNotice,
}: {
  apis: MonitoredApi[];
  onChanged: () => void;
  setNotice: (n: Notice) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState<ApiMethod>("GET");
  const [expected, setExpected] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");

  const report = async (res: { ok: boolean; error?: string }, okText: string) => {
    if (res.ok) {
      setNotice({ kind: "success", text: okText });
      onChanged();
    } else {
      setNotice({ kind: "error", text: res.error ?? "Request failed." });
    }
  };

  const add = async () => {
    const body: Record<string, string | number> = { name, url, method };
    if (expected.trim() !== "") body.expectedStatus = Number(expected);
    if (timeoutMs.trim() !== "") body.timeoutMs = Number(timeoutMs);
    const res = await api("apis", "POST", body);
    if (res.ok) {
      setName("");
      setUrl("");
      setMethod("GET");
      setExpected("");
      setTimeoutMs("");
      setAdding(false);
    }
    await report(res, "API endpoint added.");
  };

  const update = async (id: string, patch: Record<string, unknown>) => {
    const res = await api("apis", "PUT", { id, ...patch });
    await report(res, "API endpoint updated.");
  };

  const remove = async (id: string) => {
    const res = await api(`apis?id=${encodeURIComponent(id)}`, "DELETE");
    await report(res, "API endpoint removed. Its history is kept.");
  };

  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">API endpoints</h3>
      <div className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-900">
        {apis.length === 0 && <p className="py-2 text-sm text-zinc-400 dark:text-zinc-500">No API endpoints monitored.</p>}
        {apis.map((a) => (
          <ApiRow
            key={a.id}
            apiMonitor={a}
            onToggle={(v) => update(a.id, { enabled: v })}
            onUpdate={(patch) => update(a.id, patch)}
            onRemove={() => remove(a.id)}
          />
        ))}
      </div>

      {adding ? (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800 md:grid-cols-[1fr_1.4fr_0.7fr_0.7fr_0.7fr_auto]">
          <div>
            <label className={labelCls}>Name</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Health endpoint" />
          </div>
          <div>
            <label className={labelCls}>URL</label>
            <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/health" />
          </div>
          <div>
            <label className={labelCls}>Method</label>
            <select className={methodCls} value={method} onChange={(e) => setMethod(e.target.value as ApiMethod)}>
              {API_METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Expected status</label>
            <input className={inputCls} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="200" inputMode="numeric" />
          </div>
          <div>
            <label className={labelCls}>Timeout (ms)</label>
            <input className={inputCls} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} placeholder="8000" inputMode="numeric" />
          </div>
          <div className="flex items-end gap-2">
            <button type="button" onClick={add} className={btnPrimary}>Add</button>
            <button type="button" onClick={() => setAdding(false)} className={btnCls}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`${btnPrimary} mt-3`}>
          + Add API endpoint
        </button>
      )}
    </div>
  );
}

function ApiRow({
  apiMonitor,
  onToggle,
  onUpdate,
  onRemove,
}: {
  apiMonitor: MonitoredApi;
  onToggle: (v: boolean) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(apiMonitor.name);
  const [url, setUrl] = useState(apiMonitor.url);
  const [method, setMethod] = useState<ApiMethod>(apiMonitor.method);
  const [expected, setExpected] = useState(
    apiMonitor.expectedStatus != null ? String(apiMonitor.expectedStatus) : "",
  );
  const [timeoutMs, setTimeoutMs] = useState(
    apiMonitor.timeoutMs != null ? String(apiMonitor.timeoutMs) : "",
  );

  const save = () => {
    onUpdate({
      name,
      url,
      method,
      expectedStatus: expected.trim() === "" ? null : Number(expected),
      timeoutMs: timeoutMs.trim() === "" ? null : Number(timeoutMs),
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="grid grid-cols-1 gap-3 py-3 md:grid-cols-[1fr_1.4fr_0.7fr_0.7fr_0.7fr_auto]">
        <div><label className={labelCls}>Name</label><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className={labelCls}>URL</label><input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} /></div>
        <div>
          <label className={labelCls}>Method</label>
          <select className={methodCls} value={method} onChange={(e) => setMethod(e.target.value as ApiMethod)}>
            {API_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div><label className={labelCls}>Expected status</label><input className={inputCls} value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
        <div><label className={labelCls}>Timeout (ms)</label><input className={inputCls} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} /></div>
        <div className="flex items-end gap-2">
          <button type="button" onClick={save} className={btnPrimary}>Save</button>
          <button type="button" onClick={() => setEditing(false)} className={btnCls}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">{apiMonitor.name}</p>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {apiMonitor.method}
          </span>
          {!apiMonitor.enabled && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">off</span>}
        </div>
        <p className="truncate font-mono text-xs text-zinc-400 dark:text-zinc-500">{apiMonitor.url}</p>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
          expects HTTP {apiMonitor.expectedStatus ?? 200}
          {apiMonitor.timeoutMs != null ? ` · ${apiMonitor.timeoutMs}ms timeout` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Toggle checked={apiMonitor.enabled} onChange={onToggle} label="Enabled" />
        <RowControls onEdit={() => setEditing(true)} onRemove={onRemove} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

function ReposSection({
  repos,
  onChanged,
  setNotice,
}: {
  repos: MonitoredRepository[];
  onChanged: () => void;
  setNotice: (n: Notice) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [displayName, setDisplayName] = useState("");

  const report = async (res: { ok: boolean; error?: string }, okText: string) => {
    if (res.ok) {
      setNotice({ kind: "success", text: okText });
      onChanged();
    } else {
      setNotice({ kind: "error", text: res.error ?? "Request failed." });
    }
  };

  const add = async () => {
    const res = await api("repositories", "POST", { owner, repo, displayName });
    if (res.ok) {
      setOwner("");
      setRepo("");
      setDisplayName("");
      setAdding(false);
    }
    await report(res, "Repository added.");
  };

  const update = async (id: string, patch: Record<string, unknown>) => {
    const res = await api("repositories", "PUT", { id, ...patch });
    await report(res, "Repository updated.");
  };

  const remove = async (id: string) => {
    const res = await api(`repositories?id=${encodeURIComponent(id)}`, "DELETE");
    await report(res, "Repository removed. Its history is kept.");
  };

  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">GitHub repositories</h3>
      <div className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-900">
        {repos.length === 0 && <p className="py-2 text-sm text-zinc-400 dark:text-zinc-500">No repositories monitored.</p>}
        {repos.map((r) => (
          <RepoRow
            key={r.id}
            repo={r}
            onToggle={(v) => update(r.id, { enabled: v })}
            onUpdate={(patch) => update(r.id, patch)}
            onRemove={() => remove(r.id)}
          />
        ))}
      </div>

      {adding ? (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800 md:grid-cols-[1fr_1fr_1.4fr_auto]">
          <div><label className={labelCls}>Owner</label><input className={inputCls} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="github-org" /></div>
          <div><label className={labelCls}>Repository</label><input className={inputCls} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="repo-name" /></div>
          <div><label className={labelCls}>Display name</label><input className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" /></div>
          <div className="flex items-end gap-2">
            <button type="button" onClick={add} className={btnPrimary}>Add</button>
            <button type="button" onClick={() => setAdding(false)} className={btnCls}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`${btnPrimary} mt-3`}>
          + Add repository
        </button>
      )}
    </div>
  );
}

function RepoRow({
  repo,
  onToggle,
  onUpdate,
  onRemove,
}: {
  repo: MonitoredRepository;
  onToggle: (v: boolean) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState(repo.owner);
  const [repoName, setRepoName] = useState(repo.repo);
  const [displayName, setDisplayName] = useState(repo.displayName);

  const save = () => {
    onUpdate({ owner, repo: repoName, displayName });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="grid grid-cols-1 gap-3 py-3 md:grid-cols-[1fr_1fr_1.4fr_auto_auto]">
        <div><label className={labelCls}>Owner</label><input className={inputCls} value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
        <div><label className={labelCls}>Repository</label><input className={inputCls} value={repoName} onChange={(e) => setRepoName(e.target.value)} /></div>
        <div><label className={labelCls}>Display name</label><input className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
        <div className="flex items-end gap-2">
          <button type="button" onClick={save} className={btnPrimary}>Save</button>
          <button type="button" onClick={() => setEditing(false)} className={btnCls}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
            {repo.displayName || `${repo.owner}/${repo.repo}`}
          </p>
          {!repo.enabled && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">off</span>}
        </div>
        <p className="truncate font-mono text-xs text-zinc-400 dark:text-zinc-500">{repo.owner}/{repo.repo}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Toggle checked={repo.enabled} onChange={onToggle} label="Enabled" />
        <RowControls onEdit={() => setEditing(true)} onRemove={onRemove} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

function DevicesSection({
  devices,
  onChanged,
  setNotice,
}: {
  devices: MonitoredDevice[];
  onChanged: () => void;
  setNotice: (n: Notice) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [type, setType] = useState<DeviceType>("computer");

  const report = async (res: { ok: boolean; error?: string }, okText: string) => {
    if (res.ok) {
      setNotice({ kind: "success", text: okText });
      onChanged();
    } else {
      setNotice({ kind: "error", text: res.error ?? "Request failed." });
    }
  };

  const add = async () => {
    const res = await api("devices", "POST", { name, host, type });
    if (res.ok) {
      setName("");
      setHost("");
      setType("computer");
      setAdding(false);
    }
    await report(res, "Device added.");
  };

  const update = async (id: string, patch: Record<string, unknown>) => {
    const res = await api("devices", "PUT", { id, ...patch });
    await report(res, "Device updated.");
  };

  const remove = async (id: string) => {
    const res = await api(`devices?id=${encodeURIComponent(id)}`, "DELETE");
    await report(res, "Device removed. Its reachability history is kept.");
  };

  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Devices</h3>
      <div className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-900">
        {devices.length === 0 && <p className="py-2 text-sm text-zinc-400 dark:text-zinc-500">No devices monitored.</p>}
        {devices.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            onToggle={(v) => update(d.id, { enabled: v })}
            onUpdate={(patch) => update(d.id, patch)}
            onRemove={() => remove(d.id)}
          />
        ))}
      </div>

      {adding ? (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800 md:grid-cols-[1fr_1.4fr_0.8fr_auto]">
          <div>
            <label className={labelCls}>Name</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Build server" />
          </div>
          <div>
            <label className={labelCls}>Host</label>
            <input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)} placeholder="build-01.local or 10.0.0.12" />
          </div>
          <div>
            <label className={labelCls}>Type</label>
            <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
              {DEVICE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button type="button" onClick={add} className={btnPrimary}>Add</button>
            <button type="button" onClick={() => setAdding(false)} className={btnCls}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`${btnPrimary} mt-3`}>
          + Add device
        </button>
      )}
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        Reachability only. DevPulse sends one bounded ping per device — no credentials, no remote
        commands, no port scanning, no address-range discovery.
      </p>
    </div>
  );
}

function DeviceRow({
  device,
  onToggle,
  onUpdate,
  onRemove,
}: {
  device: MonitoredDevice;
  onToggle: (v: boolean) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [host, setHost] = useState(device.host);
  const [type, setType] = useState<DeviceType>(device.type);

  const save = () => {
    onUpdate({ name, host, type });
    setEditing(false);
  };

  const startEdit = () => {
    setName(device.name);
    setHost(device.host);
    setType(device.type);
    setEditing(true);
  };

  return (
    <div className="py-2">
      {editing ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1.4fr_0.8fr_auto]">
          <div><label className={labelCls}>Name</label><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className={labelCls}>Host</label><input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)} /></div>
          <div>
            <label className={labelCls}>Type</label>
            <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
              {DEVICE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button type="button" onClick={save} className={btnPrimary}>Save</button>
            <button type="button" onClick={() => setEditing(false)} className={btnCls}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-zinc-900 dark:text-zinc-50">
              {device.name}
              <span className="ml-2 rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                {device.type}
              </span>
            </p>
            <p className="truncate font-mono text-xs text-zinc-400 dark:text-zinc-500">{device.host}</p>
          </div>
          <div className="flex items-center gap-3">
            <Toggle checked={device.enabled} onChange={onToggle} label={`Enable ${device.name}`} />
            <RowControls onEdit={startEdit} onRemove={onRemove} />
          </div>
        </div>
      )}
    </div>
  );
}

function SystemThresholds({
  system,
  onChanged,
  setNotice,
}: {
  system: { cpuWarnPct: number; cpuCritPct: number; memWarnPct: number; memCritPct: number };
  onChanged: () => void;
  setNotice: (n: Notice) => void;
}) {
  const [cpuW, setCpuW] = useState(String(system.cpuWarnPct));
  const [cpuC, setCpuC] = useState(String(system.cpuCritPct));
  const [memW, setMemW] = useState(String(system.memWarnPct));
  const [memC, setMemC] = useState(String(system.memCritPct));

  const save = async () => {
    const body = {
      system: {
        cpuWarnPct: Number(cpuW),
        cpuCritPct: Number(cpuC),
        memWarnPct: Number(memW),
        memCritPct: Number(memC),
      },
    };
    const res = await api("alerts", "PUT", body);
    if (res.ok) {
      setNotice({ kind: "success", text: "Alert thresholds saved." });
      onChanged();
    } else {
      setNotice({ kind: "error", text: res.error ?? "Request failed." });
    }
  };

  const field = (label: string, value: string, set: (v: string) => void) => (
    <div>
      <label className="block pb-1 text-xs text-zinc-500 dark:text-zinc-400">{label}</label>
      <input className={inputCls} value={value} onChange={(e) => set(e.target.value)} inputMode="numeric" />
    </div>
  );

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {field("CPU warning %", cpuW, setCpuW)}
        {field("CPU critical %", cpuC, setCpuC)}
        {field("Memory warning %", memW, setMemW)}
        {field("Memory critical %", memC, setMemC)}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Sustained above a threshold across the lookback window triggers a warning (critical above the critical value).
        </p>
        <button type="button" onClick={save} className={btnPrimary}>Save thresholds</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * AI budgets
 * ------------------------------------------------------------------ */

function AiBudgets({
  ai,
  onChanged,
  setNotice,
}: {
  ai: { tokenBudget24h: number | null; costBudget24hUsd: number | null };
  onChanged: () => void;
  setNotice: (n: Notice) => void;
}) {
  const [tokEnabled, setTokEnabled] = useState(ai.tokenBudget24h != null);
  const [tok, setTok] = useState(ai.tokenBudget24h != null ? String(ai.tokenBudget24h) : "");
  const [costEnabled, setCostEnabled] = useState(ai.costBudget24hUsd != null);
  const [cost, setCost] = useState(ai.costBudget24hUsd != null ? String(ai.costBudget24hUsd) : "");

  const save = async () => {
    const body = {
      ai: {
        tokenBudget24h: tokEnabled && tok.trim() !== "" ? Number(tok) : null,
        costBudget24hUsd: costEnabled && cost.trim() !== "" ? Number(cost) : null,
      },
    };
    const res = await api("alerts", "PUT", body);
    if (res.ok) {
      setNotice({ kind: "success", text: "AI budgets saved." });
      onChanged();
    } else {
      setNotice({ kind: "error", text: res.error ?? "Request failed." });
    }
  };

  const control = (label: string, unit: string, enabled: boolean, setEnabled: (v: boolean) => void, value: string, setValue: (v: string) => void) => (
    <div className="flex items-end gap-3">
      <Toggle checked={enabled} onChange={setEnabled} label={label} />
      <input className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder={unit} disabled={!enabled} />
      <span className="pb-1.5 text-xs text-zinc-400 dark:text-zinc-500">{unit} / 24h</span>
    </div>
  );

  return (
    <div>
      <div className="space-y-3">
        {control("Token budget", "tokens", tokEnabled, setTokEnabled, tok, setTok)}
        {control("Estimated-cost budget", "USD", costEnabled, setCostEnabled, cost, setCost)}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-zinc-400 dark:text-zinc-500">Disabled budgets enforce no limit.</p>
        <button type="button" onClick={save} className={btnPrimary}>Save budgets</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Integrations (status only)
 * ------------------------------------------------------------------ */

function IntegrationRow({ name, configured }: { name: string; configured: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-zinc-700 dark:text-zinc-200">{name}</span>
      <span className="inline-flex items-center gap-1.5 text-sm">
        <span className={`h-2 w-2 rounded-full ${configured ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`} aria-hidden="true" />
        <span className={configured ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"}>
          {configured ? "Configured" : "Not configured"}
        </span>
      </span>
    </div>
  );
}

function IntegrationsStatus({ github, deepseek }: { github: boolean; deepseek: boolean }) {
  return (
    <div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
        <IntegrationRow name="GitHub" configured={github} />
        <IntegrationRow name="DeepSeek" configured={deepseek} />
      </div>
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        Set GITHUB_TOKEN and DEEPSEEK_API_KEY in <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono dark:bg-zinc-800">.env.local</code> to configure them.
      </p>
    </div>
  );
}
