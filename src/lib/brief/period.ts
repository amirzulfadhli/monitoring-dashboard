/**
 * The brief's operational period: pure arithmetic over a timestamp, so the
 * window a brief covers is identical on every read, in every process, without
 * consulting a clock of its own.
 */

import { BRIEF_WINDOW_HOURS, BRIEF_WINDOW_MS, type BriefPeriod } from "./model";

/**
 * The period containing `now`: the local calendar day, as a half-open
 * [start, end) window of exactly BRIEF_WINDOW_MS.
 *
 * `end` is derived by adding the fixed window to `start` rather than by taking
 * the next local midnight, so the window is always exactly 24 hours — including
 * across a daylight-saving change, where the calendar day itself is 23 or 25
 * hours long. The window is what the evidence and the model are told; the
 * calendar day is only how its start is chosen.
 */
export function briefPeriod(now: number): BriefPeriod {
  const d = new Date(now);
  const start = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();
  return { start, end: start + BRIEF_WINDOW_MS, hours: BRIEF_WINDOW_HOURS };
}

/** True when `ts` falls inside the half-open period window. */
export function inPeriod(ts: number, period: BriefPeriod): boolean {
  return ts >= period.start && ts < period.end;
}
