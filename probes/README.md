# probes

Throwaway-looking scripts that are anything but. Every selector and format this project
relies on was established by running one of these against a real device and reading what
came back — never by guessing at what Messenger "probably" does.

Keep them. When Messenger changes its accessibility strings (it will), these are how you
find out what it changed to.

| probe | question it answers |
|---|---|
| `dividers.ts` | what timestamp-divider formats exist in a conversation? |
| `divider-direction.ts` | does a divider label the cluster above it, or below it? |
| `tail.ts` | what is at the newest end, with dividers and messages interleaved? |
| `photo-viewer.ts` | what controls exist in the photo viewer, and which one saves? |
| `db-inspect.ts` | what does the index actually contain, and does it agree with itself? |
| `db-state.ts` | one-line health: rows, dated coverage, anchors |
| `anchor-shapes.ts` | every time-shaped node with full attributes — why did a divider get dropped? |
| `settle-check.ts` | immediate dump vs settled dump — was a missing node a timing artefact? |
| `overlap-scroll.ts` | does a small slow step reveal what a fast fling skips? (it does) |
| `fix-photo-times.ts` | repair: set each photo's sent_at from its own caption |

The last three were written in one session to chase a single bug — dividers a human could
see on screen that the reader never returned. `settle-check` **disproved** the first
hypothesis (timing); `overlap-scroll` **proved** the second (the fling skipped them).
That is what these are for: testing a guess before building on it.

Run them with `DROIDREAD_ADB` set if adb is not on PATH.

## scroll-cost.ts

What one reader step actually costs, and whether it makes progress. Written after a
150-message read spent ten minutes producing nothing, because `readThread` only printed
when it finished.

It reports, per step: whether the tree settled, how long the dump took, how many messages
were visible, how many were new, and whether the screen overlapped the last one. Steady
`new` with `overlap=yes` is healthy. Timeouts, or `new` stuck at 0, is the pathology.

This is the probe that found the real number: a single `uiautomator dump` costs 2.4s on an
SM-A146P and is perfectly stable across repeats. The reads were never looping — they were
just long, and silent.
