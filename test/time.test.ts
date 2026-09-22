// time.test.ts — divider label resolution, against a fixed "now" so results never drift.
// Run: bun test

import { expect, test } from "bun:test";
import { resolveSeparator, isSeparatorLabel } from "../src/time.ts";

const NOW = new Date(2026, 8, 22, 11, 20); // Tue 22 Sept 2026, 11:20 local

test("bare time means today", () => {
  expect(resolveSeparator("02:34", NOW)).toBe("2026-09-22 02:34:00");
  expect(resolveSeparator("10:55", NOW)).toBe("2026-09-22 10:55:00");
});

test("a bare time later than now belongs to yesterday", () => {
  // The clock moved on between the message arriving and it being read; inventing a
  // timestamp in the future would be worse than shifting a day back.
  expect(resolveSeparator("23:59", NOW)).toBe("2026-09-21 23:59:00");
});

test("weekday resolves to the most recent occurrence", () => {
  expect(resolveSeparator("MON AT 22:17", NOW)).toBe("2026-09-21 22:17:00");
  expect(resolveSeparator("SUN AT 14:13", NOW)).toBe("2026-09-20 14:13:00");
  expect(resolveSeparator("SAT AT 17:04", NOW)).toBe("2026-09-19 17:04:00");
  expect(resolveSeparator("FRI AT 14:29", NOW)).toBe("2026-09-18 14:29:00");
});

test("explicit dates keep their day", () => {
  expect(resolveSeparator("17 SEPT AT 12:06", NOW)).toBe("2026-09-17 12:06:00");
  expect(resolveSeparator("16 SEPT AT 21:57", NOW)).toBe("2026-09-16 21:57:00");
});

test("a date in the future belongs to last year", () => {
  expect(resolveSeparator("31 DEC AT 23:00", NOW)).toBe("2025-12-31 23:00:00");
});

test("non-labels are rejected rather than guessed", () => {
  expect(resolveSeparator("garbage", NOW)).toBeNull();
  expect(resolveSeparator("2 active now", NOW)).toBeNull();
  expect(isSeparatorLabel("2 active now")).toBe(false);
  expect(isSeparatorLabel("FRI AT 14:29")).toBe(true);
});
