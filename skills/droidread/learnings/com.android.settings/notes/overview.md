# Android Settings

## Go by intent, never by launcher

One step, and identical on every device and in every language:

```
droidread_open target="developer"
```

The alternative — home, open the launcher, scroll for an icon, tap it — is many fragile
steps that depend on the launcher's layout.

Short names cover `settings`, `developer`, `display`, `wifi`, `bluetooth`, `battery`,
`apps`, `accessibility`, `date`, `storage`, `security`, `about`. Any `android.settings.*`
action works too.

## `am start` lies about where you landed

It reports success when it merely brought an existing task to the front. Opening
`settings` while Developer options is already open lands you on **Developer options**, and
the launch still says it worked:

```
Warning: Activity not started, its current task has been brought to the front
```

Always confirm with `droidread_focus`. To reach the top level from a sub-screen, press
`back` rather than launching again.

## Rows nest, and the title is not where you expect

A Settings row is a clickable group containing a title and a summary. **The title's centre
sits above the group's own centre.** Any renderer that sorts elements by vertical position
prints the title before its own parent, so each title appears to belong to the row above —
which is wrong in a way that reads as correct.

Use the tree structure, not the ordering:

```
- group [ref=e7 clickable]:
  - text "Device care" [#title]
  - text "Storage • Memory • App protection" [#summary]
```

## Developer options is last

It only appears once enabled. The homepage list on this device runs: account, Connections,
Connected devices, Modes and Routines, Sounds and vibration, Notifications, Display,
Battery, Wallpaper and style, Themes, Home screen, Lock screen, Security and privacy,
Location, Safety and emergency, Accounts and backup, Digital Wellbeing, Device care, Apps,
General management, Accessibility, Software update, User guide, Remote support, About
phone, Developer options.

## Settings worth changing for automation

Animation scales to `0.0` — see `references/device-setup.md`. Developer overlays such as
pointer location and layout bounds are **not** in the accessibility tree, so they do not
affect reading; they only clutter screenshots.
