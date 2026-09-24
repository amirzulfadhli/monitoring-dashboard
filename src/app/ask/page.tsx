"use client";

import { useCallback, useState } from "react";
import {
  PageHeader,
  Panel,
  StatusBadge,
  btnPrimary,
  footnoteCls,
  inputCls,
  labelCls,
  narrowPageCls,
} from "@/components/ui";

/**
 * Ask DevPulse. One question in, one grounded answer out.
 *
 * Nothing runs on load: the page makes no request until a question is submitted,
 * and a submit makes exactly one server call (which itself makes at most one
 * instrumented DeepSeek call). There is no conversation memory, no streaming
 * and no re-asking — a new question replaces the previous answer.
 */

type Evidence = {
  id: string;
  kind: "alert" | "event" | "project" | "ai_usage" | "notification";
  source: string;
  ts: number | null;
  title: string;
  detail: string;
};

type Answer = {
  ok: true;
  answer: string;
  insufficientEvidence: boolean;
  evidence: Evidence[];
  citedEvidenceIds: string[];
  windowHours: number;
  generatedAt: number;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
};

type Failure = { ok: false; reason: string; message: string };

const EXAMPLES = [
  "What has been unhealthy today?",
  "Why is my project degraded?",
  "Were any APIs down recently?",
  "What changed in the last 24 hours?",
];

const KIND_LABEL: Record<Evidence["kind"], string> = {
  alert: "Alert",
  event: "Event",
  project: "Project",
  ai_usage: "AI usage",
  notification: "Notification",
};

function fmtWhen(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
        cache: "no-store",
      });
      const data = (await res.json()) as Answer | Failure;
      if (data.ok) {
        setAnswer(data);
      } else {
        setAnswer(null);
        setError(data.message);
      }
    } catch {
      setAnswer(null);
      setError("The question could not be sent. Nothing was changed.");
    } finally {
      setPending(false);
    }
  }, [question, pending]);

  const cited = new Set(answer?.citedEvidenceIds ?? []);

  return (
    <div className={narrowPageCls}>
      <PageHeader
        title="Ask DevPulse"
        description="Answers are grounded in monitoring evidence DevPulse has already stored. Nothing is checked, run or fetched to answer a question."
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <label htmlFor="ask-question" className="sr-only">
          Question
        </label>
        <div className="flex gap-2">
          <input
            id="ask-question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={400}
            placeholder="Ask about alerts, websites, APIs, repositories, devices, storage, AI usage…"
            autoComplete="off"
            className={`min-w-0 flex-1 ${inputCls}`}
          />
          <button
            type="submit"
            disabled={pending || question.trim().length === 0}
            className={`shrink-0 ${btnPrimary}`}
          >
            {pending ? "Asking…" : "Ask"}
          </button>
        </div>

        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${footnoteCls}`}>
          <span>Examples:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setQuestion(ex)}
              className="text-left underline-offset-2 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
            >
              {ex}
            </button>
          ))}
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          {error}
        </p>
      )}

      {answer && (
        <div className="space-y-4">
          <Panel
            title="Answer"
            action={
              answer.insufficientEvidence ? (
                <StatusBadge tone="warn">Insufficient evidence</StatusBadge>
              ) : undefined
            }
          >
            <p className="text-sm leading-relaxed whitespace-pre-line text-zinc-800 dark:text-zinc-200">
              {answer.answer}
            </p>
          </Panel>

          <Panel
            title="Evidence"
            hint={
              <>
                {answer.evidence.length} item{answer.evidence.length === 1 ? "" : "s"} supplied
                {" · "}
                last {answer.windowHours}h
                {answer.model ? ` · ${answer.model}` : ""}
              </>
            }
            padded={false}
          >
            {answer.evidence.length === 0 ? (
              <p className={`px-4 py-3 ${footnoteCls}`}>
                No stored evidence was relevant to this question.
              </p>
            ) : (
              <ul>
                {answer.evidence.map((e) => {
                  const isCited = cited.has(e.id);
                  return (
                    <li
                      key={e.id}
                      className="flex gap-3 border-b border-zinc-100 px-4 py-2.5 last:border-0 dark:border-zinc-900"
                    >
                      <span
                        className={`w-8 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums ${
                          isCited
                            ? "text-zinc-900 dark:text-zinc-100"
                            : "text-zinc-300 dark:text-zinc-600"
                        }`}
                        title={isCited ? "Cited by the answer" : "Supplied but not cited"}
                      >
                        {e.id}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className={labelCls}>{KIND_LABEL[e.kind]}</span>
                          <span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
                            {e.title}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {e.detail}
                        </p>
                      </div>
                      <span className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                        {fmtWhen(e.ts)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <p className={footnoteCls}>
            Generated {fmtWhen(answer.generatedAt)}
            {answer.usage?.outputTokens != null
              ? ` · ${answer.usage.outputTokens} output tokens`
              : ""}
            {" · "}grounded only in the evidence above.
          </p>
        </div>
      )}
    </div>
  );
}
