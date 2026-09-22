# web — the eyes

Browser viewer and tap control for the same adb-reachable device the rest of droidread
reads. The indexer works from the accessibility tree, which is precise but blind: it
cannot show you a photo, a sticker, an unlabelled dialog, or a rendering glitch. This
serves the actual screen.

It also gives the indexer two endpoints of its own. `src/screen.ts` prefers `/shot.png`
over spawning its own `adb exec-out screencap` when `DROIDREAD_STREAM_URL` is set, because
while droidread is scrolling a conversation a second capture competes with uiautomator on
the same device and slows the very read you are watching. When a browser is open the
capture loop already has the frame, so the screenshot is free.

Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan.

## Run

```bash
droidread web                      # or: bun web/server.ts
DROIDREAD_WEB_PORT=9000 droidread web
```

| env | default | meaning |
|---|---|---|
| `DROIDREAD_WEB_PORT` | `8791` | listen port; HTTPS twin on port+1 |
| `DROIDREAD_ADB` | `adb` | adb binary path |
| `DROIDREAD_WEB_FRAME_MS` | `700` | ms between frames |

The old `DROIDCAST_*` names still work as a fallback.

## No authentication

It binds `0.0.0.0` and anyone who can route to the host can view **and tap** the device.
That is the right shape for a LAN or VPN tool and the wrong shape for anything public. It
is not the MCP server: `mcp/http.ts` is the one with a token, and the two are separate on
purpose, because the viewer is for a human with a browser.

Put it on a VPN interface, or behind an SSH tunnel, and never on the open internet.

## Endpoints

| route | method | does |
|---|---|---|
| `/` | GET | MJPEG viewer, click to tap |
| `/inspect` | GET | every accessibility node drawn as a clickable box |
| `/h264` | GET | low-latency viewer (needs a scrcpy jar, see below) |
| `/stream` | GET | `multipart/x-mixed-replace` PNG frames |
| `/shot.png` | GET | one frame; `?max_age_ms=N` accepts a frame the loop already took |
| `/ui.json` | GET | the accessibility tree as JSON |
| `/devices` | GET | `adb devices` as JSON |
| `/tap` | POST | `{nx,ny}` normalised 0..1 → `input tap` |
| `/swipe` | POST | `{nx1,ny1,nx2,ny2,durMs}` → `input swipe` |
| `/key` | POST | `{code}` → `input keyevent` (4=back, 3=home, 187=recents) |

Coordinates are normalised so the browser never needs to know the device resolution; the
server scales them using a cached `wm size` per serial.

`/inspect` is the tool that makes selector-writing bearable. Automating LINE meant dumping
XML, eyeballing `bounds="[63,304][1017,502]"`, and doing centre-point arithmetic by hand,
then discovering the id targeted was an empty container. That is invisible in a screenshot
and obvious here.

## Why PNG frames and not video

One shared capture loop, one capture in flight, about 1.4fps. Measured the hard way: a
per-client loop, with a fresh adb process and a ~4MB PNG each, pushed roughly 11 MB/s over
USB until the SM-A146P re-enumerated itself mid-session.

`screencap` needs zero device-side setup and works on any adb-reachable Android. The H.264
path needs per-vendor encoder handling that is genuinely thorny: Samsung `screenrecord`
flag-spelling drift, encoders going silent on display-off, SPS/PPS changing on encoder
restart. Correct low-fps beats broken high-fps.

## The /h264 path needs a jar you supply

`web/h264.ts` drives [scrcpy](https://github.com/Genymobile/scrcpy)'s device server, which
is Apache-2.0 third-party code and is **not** bundled here. Fetch the matching release and
drop it beside the source:

```bash
curl -Lo web/scrcpy-server-v3.1 \
  https://github.com/Genymobile/scrcpy/releases/download/v3.1/scrcpy-server-v3.1
```

Without it, `/h264` fails with that message and everything else works.

## HTTPS

WebCodecs, which `/h264` needs, is secure-context only, so over plain `http://` on a LAN
address `VideoDecoder` is undefined. The server therefore also listens on port+1 with TLS,
generating a self-signed certificate on first run if `openssl` is available. The
certificate and key are gitignored: a committed private key is a published private key.
The browser warns once; accept it and `/h264` works from any machine with no SSH tunnel.

MJPEG needs none of this and stays fine on plain HTTP.

## Origin

Started as a portable sibling of `laris-co/neo-oracle`'s `tools/droidcast/DroidCast.swift`
(AppKit plus VideoToolbox, macOS only), which cannot run on a Linux host at all. Same
intent, different pipeline.
