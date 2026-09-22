# skills

Agent skills for droidread, in the [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) format.

Install by symlinking or copying into your skills directory:

```bash
ln -s "$PWD/skills/droidread" ~/.claude/skills/droidread
```

`droidread/SKILL.md` is the entry point. It stays short on purpose and points at:

- `references/` — the tool surface and the device facts, read when needed
- `learnings/<package>/` — per-app ground truth, keyed by Android package name, so app
  quirks enter context only when the phone is actually on that app

That split follows [ego-lite's ego-browser](https://github.com/citrolabs/ego-lite/tree/main/skills/ego-browser),
which keys site knowledge on the current URL. A package name is a cleaner key than a
domain: there are far fewer apps than websites, and `droidread_focus` reports it exactly.
