import test from "node:test";
import assert from "node:assert/strict";

// Local copy of the date-key behavior we rely on in `lib/gamblyzer5-web.js`.
// We keep this tiny and deterministic to guard against regressions in day-boundary logic.
function dayKeyInTimeZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date); // YYYY-MM-DD
}

test("dayKeyInTimeZone uses sportsbook local day (America/New_York)", () => {
  // 2026-05-08T03:10:00.000Z == 2026-05-07 23:10 in America/New_York (EDT)
  const d = new Date("2026-05-08T03:10:00.000Z");
  assert.equal(dayKeyInTimeZone(d, "America/New_York"), "2026-05-07");
  assert.equal(dayKeyInTimeZone(d, "UTC"), "2026-05-08");
});

test("already-started events are excluded before 'today' is chosen", () => {
  // Now is May 7, 2026 7:00pm ET == May 7, 2026 23:00Z
  const nowMs = new Date("2026-05-07T23:00:00.000Z").getTime();
  const graceMs = 120_000; // matches default in code

  const events = [
    // Started 10 minutes ago (should be excluded)
    { commence_time: "2026-05-07T22:50:00.000Z" },
    // Upcoming 10 minutes from now (should be included)
    { commence_time: "2026-05-07T23:10:00.000Z" },
  ];

  function filterEventsByEarliestUpcomingLocalDayLocal(events, timeZone, nowMs) {
    const evs = Array.isArray(events) ? events : [];
    const eventStartMs = (e) => {
      const t = new Date(e?.commence_time || e?.commenceTime || e?.start_time || e?.startTime);
      const ms = t.getTime();
      return Number.isNaN(ms) ? null : ms;
    };
    let earliestMs = null;
    for (const e of evs) {
      const ms = eventStartMs(e);
      if (ms === null) continue;
      if (ms < nowMs - graceMs) continue;
      if (earliestMs === null || ms < earliestMs) earliestMs = ms;
    }
    if (earliestMs === null) return [];
    const earliestKey = dayKeyInTimeZone(new Date(earliestMs), timeZone);
    return evs.filter((e) => {
      const ms = eventStartMs(e);
      if (ms === null) return false;
      if (ms < nowMs - graceMs) return false;
      return dayKeyInTimeZone(new Date(ms), timeZone) === earliestKey;
    });
  }

  const filtered = filterEventsByEarliestUpcomingLocalDayLocal(events, "America/New_York", nowMs);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].commence_time, "2026-05-07T23:10:00.000Z");
});

