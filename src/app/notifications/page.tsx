"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  TRANSITION_LABELS,
  type NotificationRecord,
  type NotificationSettings,
} from "@/lib/notifications/model";
import {
  EmptyState,
  PageHeader,
  StatusDot,
  StatusLabel,
  btnCls,
  btnSmall,
  cellMutedCls,
  footnoteCls,
  metaCls,
  mutedCls,
  pageCls,
  severityTone,
  toneText,
  type Tone,
} from "@/components/ui";

// The inbox is a storage read with no evaluation behind it, so a slow poll is
// plenty — this only has to notice what the scheduler recorded meanwhile.
const REFRESH_MS = 60_000;

const transitionTone: Record<string, Tone> = {
  opened: "warn",
  escalated: "critical",
  resolved: "good",
};

const sourceLabel: Record<string, string> = {
  system: "System",
  websites: "Websites",
  apis: "APIs",
  devices: "Devices",
  github: "GitHub",
  ai: "AI",
  security: "Security",
  storage: "Storage",
};

type Api = {
  unread: number;
  limit: number;
  settings?: NotificationSettings;
  notifications: NotificationRecord[];
};

function fmtWhen(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function NotificationsPage() {
  const [data, setData] = useState<Api | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (res.ok) {
        setData((await res.json()) as Api);
        setState("ok");
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await load();
    };
    void run();
    const id = setInterval(() => void run(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load]);

  const mutate = async (body: { id: string } | { all: true }) => {
    setBusy(true);
    try {
      const res = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (res.ok) await load();
    } catch {
      // Best-effort: the inbox simply keeps showing the unread state.
    } finally {
      setBusy(false);
    }
  };

  const unread = data?.unread ?? 0;
  const settings = data?.settings;

  let body: React.ReactNode;
  if (state === "error" && !data) {
    body = <EmptyState message="Notifications are temporarily unavailable." />;
  } else if (!data) {
    body = <EmptyState message="Loading notifications…" />;
  } else {
    body = (
      <div className="space-y-4">
        {settings && !settings.enabled ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-black">
            <p className={mutedCls}>
              Notifications are turned off. Alert transitions are still evaluated and stored —
              enable notifications in{" "}
              <Link href="/settings" className="underline underline-offset-2">
                Settings
              </Link>{" "}
              to record them here.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={mutedCls}>
            {unread > 0 ? (
              <>
                <span className="font-mono font-semibold text-zinc-900 dark:text-zinc-50">
                  {unread}
                </span>{" "}
                unread
              </>
            ) : (
              "Nothing unread"
            )}
            {data.notifications.length > 0 && (
              <span className="text-zinc-400 dark:text-zinc-500">
                {" "}
                · showing the {data.notifications.length} most recent
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => void mutate({ all: true })}
            disabled={busy || unread === 0}
            className={btnCls}
          >
            Mark all read
          </button>
        </div>

        {data.notifications.length === 0 ? (
          <EmptyState message="No notifications yet. They appear when an alert opens, escalates or resolves." />
        ) : (
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-black">
            {data.notifications.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                busy={busy}
                onRead={() => void mutate({ id: n.id })}
              />
            ))}
          </ul>
        )}

        <p className={footnoteCls}>
          Derived from DevPulse&apos;s own alert lifecycle — no AI-generated content, no external
          service, and no duplicate monitoring. Desktop toasts, when enabled, are Windows-local
          best-effort only.
        </p>
      </div>
    );
  }

  return (
    <div className={pageCls}>
      <PageHeader
        title="Notifications"
        description="Alert transitions recorded locally — opened, escalated and resolved."
      />
      {body}
    </div>
  );
}

function NotificationRow({
  n,
  busy,
  onRead,
}: {
  n: NotificationRecord;
  busy: boolean;
  onRead: () => void;
}) {
  const unread = n.readAt == null;
  return (
    <li
      className={`flex items-start gap-3 px-4 py-3 ${
        unread ? "bg-zinc-50/70 dark:bg-zinc-900/40" : ""
      }`}
    >
      <StatusDot
        tone={unread ? severityTone[n.severity] : "neutral"}
        className="mt-1.5 h-2 w-2"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{n.title}</span>
          <span
            className={`text-[11px] font-medium uppercase tracking-wide ${
              transitionTone[n.transition]
                ? toneText[transitionTone[n.transition]]
                : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            {TRANSITION_LABELS[n.transition] ?? n.transition}
          </span>
          <StatusLabel tone={severityTone[n.severity]} className="text-[11px] uppercase tracking-wide">
            {n.severity}
          </StatusLabel>
        </div>
        {n.message && <p className={`mt-0.5 ${cellMutedCls}`}>{n.message}</p>}
        <div className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 ${footnoteCls}`}>
          <span>{sourceLabel[n.source] ?? n.source}</span>
          {n.projectName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-zinc-500 dark:text-zinc-400">{n.projectName}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className={metaCls}>{fmtWhen(n.createdAt)}</span>
        </div>
      </div>
      {unread ? (
        <button type="button" onClick={onRead} disabled={busy} className={`shrink-0 ${btnSmall}`}>
          Mark read
        </button>
      ) : (
        <span className={`shrink-0 ${footnoteCls}`}>read</span>
      )}
    </li>
  );
}
