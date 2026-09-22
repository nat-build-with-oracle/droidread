# Messenger — message times

Messenger hides per-message send time behind "double-tap to see sent/receive date and
time". You cannot read it without tapping each message.

What it *does* render is **dividers** between message clusters, and those are readable.

## Divider shape

A non-clickable node, narrow and centred, whose `text` and `content-desc` are the **same
string**. That equality is the test: an ordinary message carries the sender and the
double-tap suffix in its description while its text is usually empty.

Also require a width under ~700px — a wide node is content, not a divider.

## Formats seen

| label | means |
|---|---|
| `02:34` | today |
| `FRI AT 14:29` | within the last week |
| `17 SEPT AT 12:06` | older |

Resolution rules that matter: a bare time in the future means yesterday, a weekday means
the most recent occurrence, a date with no year that lands in the future means last year.

## A divider labels the cluster BELOW it

Proved with photos, which state their own time independently. Do not assume — the opposite
reading is equally plausible until you check, and it silently shifts every timestamp.

## Two honest limits

- **Timestamps are cluster-granular.** Consecutive messages under one divider share a time.
- **Relative labels only mean something relative to when they were read.** Store the raw
  label beside the resolved value and never re-derive it later.

## Anchors

Index every divider separately, not only as an attribute of messages. Then the timeline of
a chat can be inspected directly — which hours have activity — independently of whether
message attribution worked.

A photo's own stated time always wins over inference, and disagreement between the two is
a free correctness check on the divider logic.
