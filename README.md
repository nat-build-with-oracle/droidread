# droidread

Read your own Android phone's chat apps over `adb`, using the **accessibility tree** —
no root, no emulator, no OCR, no screen scraping — and index them into a local SQLite
(or your own Turso cloud database).

> Built by Nexus (AI) with [Nat Weerawan](https://github.com/nazt). AI-assisted work,
> stated plainly rather than hidden.

## Why the accessibility tree

Screenshots need OCR and lose structure. The accessibility tree gives you the text
directly, plus two things a screenshot physically cannot show:

- which node is actually **clickable** (tapping a `clickable=false` container does nothing)
- which "text" is an **empty container** (a real trap: `chat_ui_row_text_message` holds no
  text while `chat_ui_message_text` does)

## Install

```bash
bun install
bun src/cli.ts devices
```

Requires [Bun](https://bun.sh) and `adb` with USB or wireless debugging authorised.

## Use

```bash
droidread devices                    # adb reachability
droidread snapshot --grep=photo      # what's on screen right now, as readable text
droidread read "Team Chat" --n=100   # read + index a conversation
droidread recap "Team Chat"          # only what's new since last run
droidread media "Team Chat"          # download photos marked pending
droidread search "invoice"           # full-text search the index
droidread where                      # where your data lives
```

## Where your data goes

**`~/.droidread/`** — outside this repo entirely, so chat content and photos cannot be
committed by accident. `.gitignore` here is a second line of defence, not the first.

Nothing leaves your machine unless *you* set `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`
(see `.env.example`), which points the same code at your own cloud database.

## How reading works

Messenger opens a conversation at the **newest** message, so reading scrolls **up**.
Two stop conditions are reliable, one is not:

| stop condition | reliable? |
|---|---|
| `--n=N` — collected N messages | yes |
| `recap` — touched history already in the database | yes |
| "reached the top of the conversation" | **no — see below** |

### The top-detection caveat, stated honestly

"Reached the top" is inferred from *content no longer changing*, and a slow lazy-load
fetch looks exactly like the end of history. Measured on one real conversation, three
runs each confidently claimed "reached top" at **33**, **46** and **6** messages — where
**88** were actually reachable.

A real position signal (did the list actually *move*?) is the fix, and is not yet
implemented. Until then: use `--n` or `recap`, and treat "reached top" as a claim rather
than a fact.

## Photos: marked on read, downloaded on demand

Photo messages carry no text, so a text-only parser silently returns a text-only history
and looks correct doing it. Instead, a read **marks** each photo in its correct
chronological position (`kind='photo'`, `media_file` NULL), and `droidread media`
downloads them later — resumable, and skipping anything already fetched.

This matters because saving is slow: each photo costs a `tap → Save → back` cycle of
roughly 8 seconds, and it drives your real Messenger UI. Marking is free.

Saving only ever taps a control **Messenger itself labels `Save`** — never a guessed
coordinate, because its neighbours are Forward, React and Delete.

## Device-specific by nature

Every selector was pinned against a **Samsung SM-A146P** running Messenger's Sept 2026
build, and they are documented at the top of `src/apps/messenger.ts`. Other devices and
other app versions will need their own ground truth. Selectors fail **loudly** rather
than silently returning nothing, so breakage is visible.

## Scope and ethics

This reads **your own device, your own conversations**, over a debugging connection you
authorised. It is not a surveillance tool: there is no remote capability, no background
service, and nothing is transmitted anywhere by default.

## Status

Working: Messenger read / recap / photo marking + download, FTS search, local + Turso.
Not done: LINE support, MCP server wrapper, the position-based top signal.

## Licence

MIT
