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

Nothing leaves your machine unless *you* set `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`,
which points the same code at your own cloud database.

Put those in **`~/.droidread/.env`** (mode `600`) rather than in your MCP client's config:

```bash
install -m 600 .env.example ~/.droidread/.env   # then edit it
```

Both the CLI and the MCP server load that file at startup, and real environment
variables always win over it. This matters because an MCP client's config file is
typically mode **644** — a Turso auth token pasted in there is world-readable.

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

## MCP server

Two-way: query what's on screen, then act on it by selector.

```bash
bun mcp/server.ts          # stdio transport
```

Register it with any MCP client, e.g.:

```json
{
  "mcpServers": {
    "droidread": {
      "command": "bun",
      "args": ["/path/to/droidread/mcp/server.ts"],
      "env": { "DROIDREAD_ADB": "/path/to/adb" }
    }
  }
}
```

| tool | touches phone? | notes |
|---|---|---|
| `droidread_devices` / `_where` / `_control_status` | no | reachability and config |
| `droidread_snapshot` | read | screen as readable text |
| `droidread_query` | read | find elements by selector, see what's clickable |
| `droidread_search` / `_list` / `_media_pending` | no | index only, phone not involved |
| `droidread_read` / `_recap` | read + scroll | slow; recap is much cheaper |
| `droidread_media_fetch` | **writes UI** | ~8s per photo |
| `droidread_tap` / `_swipe` / `_key` / `_type` | **writes UI** | opt-in, see below |

### Control is opt-in

Reading a phone is harmless. Tapping inside a live messaging app can send, forward,
react or delete — so write tools refuse unless you set:

```bash
DROIDREAD_ALLOW_CONTROL=1
```

Three further guards, each earned:

- **Taps are selector-based, never raw coordinates.** A coordinate correct one scroll ago
  lands somewhere else — this exact bug opened the wrong conversation during development.
- **Ambiguity is refused, not guessed.** Two matches is an error.
- **`droidread_type` refuses non-ASCII** rather than silently mangling it. Thai and emoji
  need an IME such as ADBKeyboard; failing loudly beats sending broken text.

`droidread_type` never presses send.

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
