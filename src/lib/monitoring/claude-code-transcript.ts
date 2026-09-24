import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  persistClaudeCodeEvents,
  readIngestMeta,
  readIngestOffset,
  writeIngestMeta,
  writeIngestOffset,
  type ClaudeCodeUsageEvent,
} from "./ai-storage";
import { estimatedCostUsd } from "./ai-pricing";

/**
 * Read-only ingestion of Claude Code usage from DevPulse's OWN local
 * transcripts. Claude Code reaches DeepSeek directly (through an
 * Anthropic-compatible bridge); DevPulse never proxies those calls. Instead we
 * read the append-only transcript JSONL Claude Code writes for this project and
 * extract only the accounting metadata each assistant event carries.
 *
 * Privacy: we JSON.parse each line (unavoidable) but keep only a fixed allowlist
 * of numeric/identifier fields — timestamps, message id, model, token counts,
 * service session id. Prompts, assistant text, tool calls, tool outputs, file
 * contents and conversation text are never read into a retained structure, never
 * logged, never persisted, and never returned through any API.
 *
 * Accuracy note: with the DeepSeek bridge, one assistant MESSAGE is emitted as
 * several assistant events (each carrying the SAME cumulative usage). Counting
 * per event would over-report tokens several-fold. We therefore treat the
 * assistant message id as the stable unit of usage and persist one row per
 * message; re-scans never duplicate thanks to a unique index on message id.
 */

/** Minimum interval between scans, so a busy page never rescans every request. */
const SCAN_MIN_MS = 30_000;
const LAST_SCAN_META = "claude_code_last_scan_ms";

/** Claude Code's project-folder encoding: `\`, `/` and `:` each become `-`. */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[\\/:]/g, "-");
}

/**
 * Resolve the Claude Code transcript directory for the current project, derived
 * from os.homedir() and the configured project path (process.cwd()) — never
 * hardcoded. Returns null when it cannot be found; callers must degrade.
 */
export function resolveClaudeTranscriptDir(): string | null {
  const base = path.join(os.homedir(), ".claude", "projects");
  const cwd = process.cwd();
  const primary = path.join(base, encodeProjectDir(cwd));
  try {
    if (statSync(primary).isDirectory()) return primary;
  } catch {
    // fall through to disambiguation
  }

  // Drive-letter casing can differ between process.cwd() and how Claude Code
  // recorded the path. Fall back to a case-insensitive match of the encoded
  // name among sibling project dirs — bounded to the projects root only.
  const want = encodeProjectDir(cwd);
  let dirs: string[];
  try {
    dirs = readdirSync(base);
  } catch {
    return null;
  }
  for (const name of dirs) {
    if (name.toLowerCase() === want.toLowerCase()) {
      return path.join(base, name);
    }
  }
  return null;
}

/** Coerce a transcript JSON number to a safe integer/null. */
function toInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

/** Narrow an untrusted parsed JSON value to a plain object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parse an ISO event timestamp; falls back to the file's mtime. */
function tsOf(raw: unknown, fallbackMs: number): number {
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return ms;
  }
  return fallbackMs;
}

type ParsedEvent = {
  ts: number;
  sessionId: string | null;
  model: string | null;
  messageId: string;
  input: number | null;
  output: number | null;
  thinking: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
  cost: number | null;
};

/**
 * Reduce one transcript line to accounting metadata only. Returns null when the
 * line is not an assistant usage event (or is malformed). No content is kept.
 */
function parseAssistantEvent(line: string, fallbackMs: number): ParsedEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // malformed / partially-written line — never abort ingestion
  }
  if (!isRecord(parsed)) return null;
  const ev = parsed;
  if (ev.type !== "assistant") return null;
  const msg = ev.message;
  if (!isRecord(msg)) return null;
  const usage = msg.usage;
  if (!isRecord(usage)) return null;

  const messageId = typeof msg.id === "string" ? msg.id : null;
  if (!messageId) return null; // no stable key — cannot dedupe, so skip

  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
  const input = toInt(usage.input_tokens);
  const output = toInt(usage.output_tokens);
  const thinking = toInt(details?.thinking_tokens);
  const cacheCreation = toInt(usage.cache_creation_input_tokens);
  const cacheRead = toInt(usage.cache_read_input_tokens);
  const model = typeof msg.model === "string" ? msg.model : null;

  // Estimated cost from reliable input/output counts only. Cache fields are not
  // authoritative for DeepSeek, so no cache discount is applied; the figure is
  // an estimate and is labelled as such downstream.
  const cost = estimatedCostUsd({
    provider: "deepseek",
    model,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: null,
  });

  return {
    ts: tsOf(ev.timestamp, fallbackMs),
    sessionId:
      typeof ev.sessionId === "string"
        ? ev.sessionId
        : typeof ev.session_id === "string"
          ? ev.session_id
          : null,
    model,
    messageId,
    input,
    output,
    thinking,
    cacheCreation,
    cacheRead,
    cost,
  };
}

/** Deduplicate within one read pass by message id (the stable key). */
function dedupe(events: ParsedEvent[]): ParsedEvent[] {
  const seen = new Set<string>();
  const out: ParsedEvent[] = [];
  for (const e of events) {
    if (seen.has(e.messageId)) continue;
    seen.add(e.messageId);
    out.push(e);
  }
  return out;
}

/** Byte read of only the appended portion of one transcript file. */
function readAppended(
  file: string,
  offset: number,
): { buf: Buffer; newOff: number; size: number } | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null; // locked / unavailable / vanished — leave offset unchanged
  }
  try {
    let size: number;
    try {
      size = fstatSync(fd).size;
    } catch {
      return null;
    }
    if (offset > size) offset = 0; // file truncated/rotated — re-read from top
    if (offset === size) return { buf: Buffer.alloc(0), newOff: offset, size };
    const len = size - offset;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return { buf, newOff: offset, size };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore close errors
    }
  }
}

/** Split a byte buffer into complete lines; returns the byte end of the last newline. */
function completeLines(buf: Buffer): { lines: string[]; end: number } {
  const lines: string[] = [];
  let start = 0;
  let end = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      // Decode one complete line. A trailing partial line (no newline yet) is
      // intentionally excluded so we never persist a half-written event.
      lines.push(buf.toString("utf8", start, i));
      start = i + 1;
      end = i + 1;
    }
  }
  return { lines, end };
}

export type IngestResult = {
  /** true when this call actually attempted a scan (false if throttled). */
  attempted: boolean;
  ok: boolean;
  dirFound: boolean;
  throttled: boolean;
  filesScanned: number;
  insertedRows: number;
};

/**
 * Scan Claude Code transcripts for the current project and persist any usage not
 * yet recorded. Incremental: only bytes appended since each file's last
 * committed offset are read. Idempotent: message ids already persisted are
 * ignored. Throttled so repeated requests do not rescan more than necessary.
 * Never throws and never blocks direct usage on failure.
 */
export function ingestClaudeCodeUsage(): IngestResult {
  const noop: IngestResult = {
    attempted: false,
    ok: false,
    dirFound: false,
    throttled: false,
    filesScanned: 0,
    insertedRows: 0,
  };

  const now = Date.now();
  const last = readIngestMeta(LAST_SCAN_META);
  if (last != null && now - last < SCAN_MIN_MS) {
    return { ...noop, attempted: false, ok: true, throttled: true };
  }
  writeIngestMeta(LAST_SCAN_META, now); // claim the slot before scanning

  const dir = resolveClaudeTranscriptDir();
  if (!dir) {
    return { ...noop, attempted: true, dirFound: false };
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { ...noop, attempted: true, dirFound: true };
  }
  files.sort();

  let insertedRows = 0;
  let scanned = 0;
  for (const f of files) {
    const file = path.join(dir, f);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue; // disappeared between discovery and read
    }
    const offset = readIngestOffset(file);
    const got = readAppended(file, offset);
    if (!got || got.buf.length === 0) continue;
    scanned++;

    const { lines, end } = completeLines(got.buf);
    const parsed: ParsedEvent[] = [];
    for (const line of lines) {
      const lineText = line.trim();
      if (!lineText) continue;
      const p = parseAssistantEvent(lineText, st.mtimeMs);
      if (p) parsed.push(p);
    }
    const unique = dedupe(parsed);
    if (unique.length === 0) continue;

    const mapped: ClaudeCodeUsageEvent[] = unique.map((p) => ({
      ts: p.ts,
      sessionId: p.sessionId,
      model: p.model,
      messageId: p.messageId,
      inputTokens: p.input,
      outputTokens: p.output,
      thinkingTokens: p.thinking,
      cacheCreationTokens: p.cacheCreation,
      cacheReadTokens: p.cacheRead,
      estimatedCostUsd: p.cost,
    }));

    const inserted = persistClaudeCodeEvents(mapped);
    if (inserted < 0) return { ...noop, attempted: true, ok: false, dirFound: true }; // DB down — retry later
    insertedRows += inserted;
    writeIngestOffset(file, offset + end); // commit only after persistence
  }

  return {
    attempted: true,
    ok: true,
    dirFound: true,
    throttled: false,
    filesScanned: scanned,
    insertedRows,
  };
}
