# Tools

Cost matters more than capability here: the phone is slow, so knowing which tools touch it
is how you stay fast.

## Free — the index only, phone not involved

| tool | args | does |
|---|---|---|
| `droidread_where` | — | where data is stored, cloud sync, and whether the device is busy |
| `droidread_search` | `query`, `limit` | full-text search everything indexed (FTS5) |
| `droidread_list` | `chat`, `n` | indexed messages for a chat, chronological |
| `droidread_anchors` | `chat` | every timestamp divider ever seen, newest first |
| `droidread_since` | `chat`, `since` | messages at or after a local time |
| `droidread_media_pending` | `chat` | photos marked but not downloaded |
| `droidread_devices` | — | adb reachability |
| `droidread_control_status` | — | is write control enabled |

`droidread_since` reports rows with **no known send time separately** and never assumes
they are inside or outside the window. Trust that separation; do not average it away.

## Cheap — reads the device

| tool | cost | does |
|---|---|---|
| `droidread_focus` | instant | which window has focus. Start here |
| `droidread_snapshot` | ~2.4s | the tree, with `[ref=eN]` handles. **The one you act on** |
| `droidread_query` | ~2.4s | find elements by selector |
| `droidread_screenshot` | ~0.5s | the picture. Free when the web viewer runs |
| `droidread_read_screen` | ~5s | index the messages visible now. **The loop primitive** |
| `droidread_open_chat` | ~5s | open a conversation and stop |

`droidread_snapshot` takes `grep` and `all`. Refs are assigned from the **full** tree even
when you grep, so a filtered view still gives usable handles.

`droidread_screenshot` takes `width` (default 540) and `quality`. A raw 1080×2408 PNG costs
roughly ten times the tokens; there is rarely a reason for `width: 0`.

## Writes the UI — needs `DROIDREAD_ALLOW_CONTROL=1`

| tool | args | notes |
|---|---|---|
| `droidread_tap` | `ref` **or** one selector | prefer `ref`. Refuses on 0 or 2+ matches |
| `droidread_type` | `text`, optional `ref` | ASCII only, never presses send |
| `droidread_swipe` | `direction`, `durationMs` | `up` reveals older messages |
| `droidread_key` | `back`/`home`/`enter`/`wake` | in a chat, one back → inbox, two → leaves the app |
| `droidread_open` | `target` | a Settings screen, an intent action, or a package |
| `droidread_media_fetch` | `chat`, `cap` | ~8s per photo. Use a small cap |

`droidread_open` short names: `settings`, `developer`, `display`, `wifi`, `bluetooth`,
`battery`, `apps`, `accessibility`, `date`, `storage`, `security`, `about`. It verifies by
reading the focused window afterwards, because `am start` reports success even when it
merely brought an existing task to the front — so opening `settings` while a sub-screen is
open lands you on that sub-screen. Press `back` to reach the top level.

## Selectors

Exactly one of `id`, `text`, `textContains`, `desc`, `descContains`. Prefer a `ref`.

Some apps strip resource-ids — Messenger reports the literal string `(name removed)` for
every node, so `id` is useless there and text or description is all you have.

## One phone, one driver

Everything that touches the device runs through a lock, in arrival order. A second
caller's read waits rather than corrupting the first. `droidread_where` says whether the
device is busy and for how long.

Screenshots deliberately skip the lock: looking changes nothing, and the point of being
able to look is to look **while** a long read runs.
