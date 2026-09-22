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
droidread screenshot                 # the picture, not the tree
droidread web                        # browser viewer + tap control (LAN/VPN)
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

### How scrolling is done, and why it is slow on purpose

The reader scrolls **600px at 300ms** — about a third of a screen, with no fling
momentum — and checks that every capture **overlaps** the previous one (shares at least
one message or divider). Zero overlap means content was skipped; it backs up and re-reads.

This replaced a 1400px fling, which was measured skipping whole regions between
captures. Content-dedup hid the holes: the index looked fine, it was just missing
things. Concretely, the fling returned 2 of one morning's 4 timestamp dividers; the
small step returned all 4. The same overshoot is the likely cause of earlier runs
"reaching the top" at 33, 46 and 6 messages where 88 were reachable.

Every dump also waits for the tree to **settle** (`dumpSettled`) before being read.

### Device settings that matter

Turn animations off on the phone. Messenger animates message rows, and a tree that keeps
changing is a tree that never settles:

```bash
adb shell settings put global window_animation_scale 0.0
adb shell settings put global transition_animation_scale 0.0
adb shell settings put global animator_duration_scale 0.0
```

Restore with `1.0`. Also worth setting a long screen timeout, since a read takes minutes.

### A step costs seconds, so reads take minutes

Measured on an SM-A146P: one `uiautomator dump` is a steady **2.4 seconds**, and five
consecutive dumps returned byte-identical 94-node trees. That single number explains a lot.

It explains the old "tree did not settle" warnings, which were arithmetic rather than a
restless screen: proving stability needed three dumps, 8000ms, inside a 6000ms budget that
could never contain them. The defaults now assume a slow dump and a calm tree.

It also explains why a 150-message read is roughly seven minutes. Since Thai messages are
long, a screen holds 2-7 of them and a step yields about 2 new ones. So a read now reports
after every screen and **writes as it goes** — a run killed at minute ten used to lose all
ten minutes of work. `--max-ms` sets a wall-clock budget, which is the limit that actually
binds.

### Timestamps

Messenger hides per-message send time behind "double-tap to see sent/receive date and
time", but renders **dividers** between message clusters — `10:14`, `FRI AT 14:29`,
`17 SEPT AT 12:06` — and those are readable. A divider timestamps the cluster **below**
it (proved with photos, which state their own time; see `probes/divider-direction.ts`).

Two consequences, stated plainly:

- Timestamps are **cluster-granular**. Consecutive messages under one divider share it.
- Relative labels (`FRI`, a bare time) only mean something relative to when they were
  read, so the raw label is stored beside the resolved value and is never re-derived.

Every divider is also indexed on its own in `anchors` — the timeline of a chat can be
inspected directly (`droidread anchors <chat>`) independently of message assignment.
Photos' own stated time always wins over inference.

## Photos: marked on read, downloaded on demand

Photo messages carry no text, so a text-only parser silently returns a text-only history
and looks correct doing it. Instead, a read **marks** each photo in its correct
chronological position (`kind='photo'`, `media_file` NULL), and `droidread media`
downloads them later — resumable, and skipping anything already fetched.

This matters because saving is slow: each photo costs a `tap → Save → back` cycle of
roughly 8 seconds, and it drives your real Messenger UI. Marking is free.

Saving only ever taps a control **Messenger itself labels `Save`** — never a guessed
coordinate, because its neighbours are Forward, React and Delete.

## Probes

Every selector and format here was established by running a probe against a real device
and reading what came back. They live in `probes/` and are meant to be re-run whenever
Messenger changes something:

```bash
bun probes/dividers.ts            # what timestamp formats exist
bun probes/divider-direction.ts   # does a divider label the cluster above or below
bun probes/tail.ts "Chat Name"    # newest end, dividers and messages interleaved
bun probes/photo-viewer.ts        # what controls the photo viewer offers
bun probes/db-inspect.ts          # what the index holds, and whether it agrees with itself
```

`db-inspect.ts` is the useful one to run after any timestamp work: photos state their own
time, so comparing that against the inferred `sent_at` is a free correctness check.

```bash
bun test                          # divider-label resolution, against a fixed clock
```

## Where temporary files go

Nothing in this project writes to `/tmp`. Runtime artifacts (logs, intermediate JSON)
belong under `~/.droidread/` — `~/.droidread/logs/` for run logs — so they sit beside the
data they describe and never land in a shared world-readable directory.

## MCP server

Two-way: query what's on screen, then act on it by selector. Two transports, same tools:

```bash
bun mcp/server.ts          # stdio — one local client, no network
bun mcp/http.ts            # Streamable HTTP — agents on other machines, token-gated (see below)
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
| `droidread_snapshot` | read | screen as readable text — cheap, and the one you act on |
| `droidread_screenshot` | read | the picture; free when the web viewer is running |
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

### Over the network: LAN or VPN

The stdio server serves one client on the same machine. To let agents on other machines
use the phone, run the HTTP transport on the machine adb lives on:

```bash
echo "DROIDREAD_MCP_TOKEN=$(openssl rand -hex 32)" >> ~/.droidread/.env   # once; file is mode 600
DROIDREAD_MCP_HOST=10.20.0.7 bun mcp/http.ts                              # your WireGuard IP
```

`DROIDREAD_MCP_HOST` is a comma-separated list of interfaces to bind; the default is
`127.0.0.1`, reachable from nowhere else on purpose. `DROIDREAD_MCP_PORT` defaults to
7373. Both can also live in `~/.droidread/.env`.

On the other machine:

```bash
claude mcp add --transport http --scope user droidread \
  http://10.20.0.7:7373/mcp --header "Authorization: Bearer <token>"
```

What this opens, and what guards it:

- **Whoever reaches the port with the token can read every indexed chat and the phone's
  screen.** The token is checked on every request with a constant-time compare, and the
  server refuses to start without one.
- **Prefer a VPN interface over the LAN.** WireGuard and Tailscale encrypt the tunnel;
  plain HTTP on a LAN sends the token in clear to anyone on the same wifi. There is no
  TLS here by design — put it behind a tunnel, not on a public interface.
- **The control gate stays server-side.** Tap/swipe/type work only if the *server*
  process was started with `DROIDREAD_ALLOW_CONTROL=1`; a remote client cannot turn it on.
- **One phone, one driver.** Phone-touching tools go through a device lock; a second
  agent's `droidread_read` waits for the first to finish rather than corrupting it.
  `droidread_where` reports whether the device is busy and for how long.
- **`/health`** answers without a token and says only `{"ok":true}` — for reachability
  checks from the other side of the tunnel.
- **Nothing is open unless you start it.** Stopping the process closes the door.

To keep it up across logins, a systemd user unit is enough:

```ini
[Unit]
Description=droidread MCP over HTTP
[Service]
ExecStart=/usr/bin/env bun /path/to/droidread/mcp/http.ts
Restart=on-failure
[Install]
WantedBy=default.target
```

## Watching it work: the web viewer

`web/` serves the phone's actual screen to a browser, with click-to-tap and an inspector
that draws every accessibility node as a box you can click. The tree is precise but blind;
this is how you see a photo, a sticker, an unlabelled dialog, or a rendering glitch.

```bash
droidread web                     # http://0.0.0.0:8791, HTTPS twin on 8792
```

It also makes screenshots free. Point droidread at the viewer and `droidread_screenshot`
takes the frame the capture loop already produced instead of spawning its own
`adb exec-out screencap`, which otherwise competes with uiautomator and slows the very read
you are watching:

```bash
DROIDREAD_STREAM_URL=http://127.0.0.1:8791
```

Unset or unreachable, it falls straight back to adb and says so.

**The viewer has no authentication**, binds `0.0.0.0`, and lets anyone who can route to it
tap your phone. That is deliberate for a LAN or VPN tool and wrong for anything public. It
is not the MCP server; `mcp/http.ts` is the one with a token. See `web/README.md`.

## Device-specific by nature

Every selector was pinned against a **Samsung SM-A146P** running Messenger's Sept 2026
build, and they are documented at the top of `src/apps/messenger.ts`. Other devices and
other app versions will need their own ground truth. Selectors fail **loudly** rather
than silently returning nothing, so breakage is visible.

## Scope and ethics

This reads **your own device, your own conversations**, over a debugging connection you
authorised. It is not a surveillance tool: nothing is transmitted anywhere by default,
there is no background service, and the one network transport (`mcp/http.ts`) is off
unless you start it, binds to localhost unless you say otherwise, and refuses every
request without your token.

## Status

Working: Messenger read / recap / photo marking + download, FTS search, local + Turso.
Not done: LINE support; per-message (rather than per-cluster) timestamps, which Messenger
does not expose without tapping each message.

## Licence

MIT
