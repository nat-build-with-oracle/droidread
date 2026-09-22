# learnings — what is known about each app

Selectors are app-specific and version-fragile. Rather than carrying every app's quirks in
the main skill, each app gets a pack keyed by its **package name**:

```
learnings/<package>/
  manifest.json       # which package and activities this pack covers
  notes/overview.md   # the ground truth: selectors, traps, what to do first
  notes/<topic>.md    # optional deeper notes
```

`droidread_focus` returns the focused window, which begins with the package name. That is
the key — look up the matching pack before probing an app from scratch.

Prefix a directory with `_` to disable it without deleting it.

## Writing a pack

Write down what a **dump proved**, not what the UI looks like. A note that says "tap the
send button" is worthless; a note that says `Button desc="Send"` and that neighbouring
controls are Forward and Delete is what stops a wrong tap.

Every claim should be reproducible by re-running a probe. When an app updates and a
selector breaks, fix the note in the same commit as the code.

State the device and app version the ground truth came from. Selectors that are true on one
build are routinely false on the next, and a note that does not say when it was true cannot
be checked.
