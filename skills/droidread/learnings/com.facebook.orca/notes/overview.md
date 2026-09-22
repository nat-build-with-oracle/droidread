# Messenger — ground truth

Every selector here was read off a real dump. None is guessed, and all are version-fragile.
They fail loudly rather than silently returning nothing.

## Messenger strips resource-ids

Every node reports the literal string `(name removed)`. **Text and content-description are
the only usable selectors.** Treat `(name removed)` as absent, or every node appears to
share one id.

## What a message looks like

A text message is one node whose content-description joins sender and body and ends with a
fixed suffix:

```
"<Sender>, <body>, double-tap to see sent/receive date and time, double-tap and hold to react on message"
```

That suffix is the only reliable marker. Split on the first `", "` to separate sender from
body.

**Photo messages carry no such suffix**, so a parser that matches only on it returns a
text-only history and looks correct doing it. Images were never dropped by a bug — they
were never in scope. See `photos.md`.

## Am I in a conversation?

The inbox contains a node whose text includes `Ask Meta AI`. Inside a conversation it is
absent. That is the check `droidread_open_chat` uses.

## Opening a conversation

Messenger resumes into the **last conversation**, not the inbox, so getting to a named chat
means backing out first. **Exactly one back per attempt** — a second press leaves the app.

The visible `Unread X.` node is often `clickable=false`. The real target is the wrapping
button whose description contains the chat name. A tap on the non-clickable node does
nothing, confirmed live.

After tapping, **verify you navigated**. A coordinate read before the list scrolled lands
on the wrong row, and this exact bug opened the wrong conversation.

## Reading direction

A conversation opens at the **newest** message, so reading history scrolls **up**.
