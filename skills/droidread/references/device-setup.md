# Device setup, and what things actually cost

Every number here was measured on a Samsung SM-A146P. Measure your own before trusting
them — the numbers are the point, not the hardware.

## Turn device animations off

Do this first. Apps animate rows, and a tree that keeps changing is a tree that never
settles.

```bash
adb shell settings put global window_animation_scale 0.0
adb shell settings put global transition_animation_scale 0.0
adb shell settings put global animator_duration_scale 0.0
```

Restore with `1.0`. A long screen timeout helps too, since a read runs for minutes:

```bash
adb shell settings put system screen_off_timeout 1800000
adb shell settings put global stay_on_while_plugged_in 2
```

## A dump costs 2.4 seconds

This single number explains most of what droidread does.

| operation | cost |
|---|---|
| one `uiautomator dump` | **2.4s**, steady |
| a settled dump (2 dumps + poll) | ~5s |
| one reader step: settle + swipe | ~5s |
| new messages per step | ~2, for long messages |
| `adb exec-out screencap -p` | ~0.5s, 470KB PNG |

So 150 messages is roughly **seven minutes**. That is arithmetic, not a bug. Plan around
it: read what you need, not everything.

Five consecutive dumps returned byte-identical 94-node trees, so the tree itself is calm.
It is the dump that is slow.

### The bug this number found

"Tree did not settle" warnings used to fire constantly on a perfectly still screen.
Proving stability needed three dumps — 3 × 2400ms + 2 × 400ms = 8000ms — inside a 6000ms
budget that could never contain them.

**If you add a settle rule, make its timeout bigger than the work it requires.** Measure
the dump first.

## Scrolling: small steps, and check the overlap

The reader scrolls **600px at 300ms**, about a third of a screen, with no fling momentum,
and checks that each capture **overlaps** the previous one.

A 1400px fling was measured skipping whole regions between captures. Content-dedup hid the
holes, so the index looked fine and was quietly missing things. Concretely: the fling
returned 2 of one morning's 4 timestamp dividers, the small step returned all 4. The same
overshoot is the likely cause of earlier runs "reaching the top" at 33, 46 and 6 messages
where 88 were reachable.

**Zero overlap between consecutive screens means content was skipped.** Back up and
re-read rather than accepting the hole.

## "Reached the top" is a claim, not a fact

Inferred from content no longer changing, and a slow lazy-load fetch looks identical to
the end of history. Three runs on one conversation claimed the top at 33, 46 and 6
messages.

The dependable stop conditions are a target count, contact with already-indexed history,
and the literal `START OF CONVERSATION` marker.

## adb

```bash
adb devices                      # confirm exactly one
adb connect <phone-ip>:5555      # wireless, after `adb tcpip 5555` once over USB
```

Set `DROIDREAD_ADB` when adb is not on PATH. A second adb capture competes with
uiautomator on the same device, so if the web viewer is running, point screenshots at it
with `DROIDREAD_STREAM_URL` and they cost the phone nothing.

## When a dump fails

`no UI hierarchy — screen off, locked, or a secure window is in front` is literal. Wake
the device, unlock it, and check nothing is showing a `FLAG_SECURE` window (banking apps,
password managers). uiautomator cannot see those and never will.
