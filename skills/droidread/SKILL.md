---
name: droidread
description: Read and drive a real Android phone over adb through the accessibility tree — index chat apps, navigate settings, tap by ref. Use when the task involves a physical Android device, reading messages off a phone, or automating an Android app that has no API.
---

# droidread

Drive a real Android phone over `adb`, reading the **accessibility tree** rather than
pixels. No root, no emulator, no OCR.

The tree is faster than screenshots, needs no OCR, and shows two things a screenshot
physically cannot: which node is actually **clickable**, and which "text" is an **empty
container**. That second one is a real trap — automating LINE meant targeting
`chat_ui_row_text_message`, which holds no text, while `chat_ui_message_text` does.

## The loop is yours

No tool scrolls for you. This is deliberate, and it is the most important thing on this
page.

Reading a conversation takes minutes. A tool that owns that loop leaves you blind: no
output until it returns, no way to steer, no way to stop early, and a cancellation throws
away everything it had. That happened twice during development, and both times the work
was lost.

So the tools are primitives and **you** decide when to stop:

```
droidread_open_chat    chat="Team"
droidread_read_screen  chat="Team"      -> 6 on screen · 6 new · 2 time dividers
droidread_swipe        direction=up
droidread_read_screen  chat="Team"      -> 5 on screen · 5 new
droidread_swipe        direction=up
droidread_read_screen  chat="Team"      -> 4 on screen · 0 new
```

Each call is about five seconds and **indexes as it reads**, so stopping at any point
keeps everything so far. Stop when you have what you came for, when two screens in a row
bring nothing new, or when `START OF CONVERSATION` appears.

Do not batch twenty swipes hoping to go faster. Reading is slow because the device is
slow; see `references/device-setup.md` for the measurements.

## Refs, not coordinates

`droidread_snapshot` gives every actionable element a handle:

```
- list [#recycler_view]:
  - group [ref=e7 clickable]:
    - text "Device care" [#title]
    - text "Storage • Memory • App protection" [#summary]
```

Pass `ref: "e7"` to `droidread_tap`. Before the tap lands, the element is re-found in a
**fresh** dump by its identity, so a scroll in between is caught and refused.

A raw coordinate would not fail. It would hit whatever moved into that spot — which is how
a tap once opened the wrong conversation. **Refs belong to the latest snapshot**; take a
new one after anything that changes the screen.

## Read before you act

The cheapest correct order is always:

1. `droidread_focus` — where am I? One line, no cost.
2. `droidread_snapshot` — what is here, and what can I act on?
3. `droidread_tap` / `_type` / `_swipe` — act, by ref.
4. Snapshot again before the next action.

Reach for `droidread_screenshot` **second, not first**. The tree is far cheaper and is the
only thing you can act on by selector. The picture is for what the tree cannot say: a
photo, a sticker, a dialog drawn without accessibility labels, a rendering glitch. It
earned its place once by revealing developer overlays drawn over an app that appeared
nowhere in the tree.

## When something is not found

Errors tell you whether retrying can possibly help.

- **transient** — nothing matched. It may be offscreen, or the screen may still be
  loading. Swiping or re-observing is a reasonable next move.
- **permanent** — several things matched, and the error lists the candidates. Retrying
  identically fails identically. Pick one by ref, or use a more specific selector.

That distinction matters because every attempt costs a 2.4-second dump. An agent that
retries an ambiguous selector burns minutes and cannot succeed.

## Control is opt-in, and stays off by default

Reading a phone is harmless. Tapping inside a live messaging app can send, forward, react
or delete. So `droidread_tap`, `_swipe`, `_key`, `_type` and `_open` refuse unless the
server was started with `DROIDREAD_ALLOW_CONTROL=1`. A remote caller cannot switch it on.

Two further rules, each learned the hard way:

- **Ambiguity is refused, never guessed.** Two matches is an error.
- **`droidread_type` refuses non-ASCII** rather than silently mangling it, and never
  presses send. Thai and emoji need an IME such as ADBKeyboard.

Inside a chat, one `back` returns to the inbox and a second leaves the app.

## Privacy

This reads **the operator's own device, their own conversations**, over a debugging
connection they authorised. Extracted content lives in `~/.droidread/`, outside any repo,
and nothing is uploaded unless the operator sets their own Turso credentials.

Do not paste message content anywhere it was not asked for. When reporting, summarise;
quote only what the task needs.

## Per-app knowledge

Selectors are app-specific and version-fragile. What is known about an app lives in
`learnings/<package>/`, keyed by package name — check there before probing from scratch:

| package | app |
|---|---|
| `com.facebook.orca` | Messenger: message shape, photos, timestamp dividers |
| `com.android.settings` | Settings: reaching screens by intent |

`droidread_focus` tells you the current package, which tells you which pack applies.

If you work out something durable about a new app, add a pack. The format is in
`learnings/README.md`.

## References

- `references/tools.md` — every tool, its arguments, and what it costs
- `references/device-setup.md` — adb, device settings that matter, measured timings
