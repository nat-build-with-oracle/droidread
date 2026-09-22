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

Run them with `DROIDREAD_ADB` set if adb is not on PATH.
