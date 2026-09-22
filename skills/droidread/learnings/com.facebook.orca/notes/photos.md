# Messenger — photos

## In the thread

| what | selector |
|---|---|
| the photo | `Button` desc `"Received photo message"` or `"Sent photo message"` |
| its identity | `ViewGroup` desc `"Forward photo sent by <Sender> on 16 Sept at 18:27"` |

The nearest identity node by vertical distance identifies the photo. It also carries the
sender and a stated time, which is more reliable than divider inference.

## Mark on read, download on demand

A read **marks** a photo in its correct chronological position and moves on. Downloading
happens separately, later, and skips anything already fetched.

This matters because saving is slow: each photo costs a tap, Save, back cycle of roughly
**8 seconds**, and it drives the real UI. Marking is free. A read that downloaded inline
would take hours and could not be interrupted.

## Saving

In the viewer, tap the control Messenger itself labels `Save`:

```
Button desc="Save"    (beside "Add to story", "More", "Close")
```

**Never guess a coordinate here.** The neighbours are Forward, React and Delete. If no
`Save` control is present, back out and report rather than tapping where it usually is.

Exit the viewer with exactly one back — verified to land back in the thread.

Saved files land in `/sdcard/Pictures/Messenger/` at original quality. Diff the directory
listing before and after to learn the new filename.

## An empty identity is honest

One photo returned an empty identity string. Left as a marker with no reference rather
than inventing one; the pending-download query simply skips references that are empty.
