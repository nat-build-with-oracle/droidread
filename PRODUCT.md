# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vanilla HTML/CSS/JS, served directly by Bun (`Bun.serve`), no framework, no build step. Established by `web/server.ts` and followed by `web/data.ts`.

## Users

The operator running droidread on their own machine, against their own Android phone. A single-user, local-first tool — not built for a team or a hosted audience. When the data viewer (`web/data.ts`) is opened over a LAN or VPN, the audience is still just the operator, from a second device.

## Product Purpose

droidread reads chat apps on an Android phone through the accessibility tree — no root, no OCR, no screen scraping — and indexes messages, timestamps, and photos into a local (or self-hosted Turso) database. It exists because chat apps expose no API for reading your own history programmatically; the accessibility tree is the only structured channel available.

Two viewers sit on top of the same data for different jobs:
- `web/server.ts` mirrors the live phone screen and allows tap control — for driving the phone.
- `web/data.ts` browses what has already been indexed and downloaded — messages, search, photos — entirely offline from the phone, no adb required.

## Positioning

Phone-mirroring tools show you the screen. Chat export/backup tools give you an opaque file. droidread does neither: it gives you a structured, searchable, timestamped record of your own conversations, extracted from the same accessibility tree a screen reader would use, with every fact (a message's send time, whether a photo is downloaded) stored honestly — unresolved or unknown rather than guessed.

## Durable Constraints

- **Privacy is the product's central constraint, not an afterthought.** Data defaults to `~/.droidread/`, outside any repo. Nothing leaves the machine unless the operator sets their own Turso credentials. The data viewer binds to loopback by default; opening it to a LAN is an explicit, documented choice, not the default.
- **No authentication on either local viewer.** Both assume a trusted network (own LAN/VPN) rather than implementing login. This is a stated tradeoff, not an oversight.
- **Honesty about uncertainty is load-bearing.** Message send time (`sent_at`) can be genuinely unknown (a message read before any timestamp divider was captured) — the UI must show "no known time," never silently invent one. Reading order is extraction order, not a proven chronological timeline; the two can diverge when a conversation was read in multiple passes.
- **Mixed-language content.** Real data is predominantly Thai with English mixed in; UI and rendering must not assume Latin-only text (no truncation that breaks multi-byte characters, no LTR-only layout assumptions).
- **Photos are marked before they're downloaded.** A `kind='photo'` row can have `media_file IS NULL` — pending, not missing. The UI must distinguish "not downloaded yet" from "downloaded" rather than treating both as broken images.
- **No phone required for the data viewer.** `web/data.ts` must work with the phone off, unreachable, or never connected this session — it only reads the database and files already on disk.
