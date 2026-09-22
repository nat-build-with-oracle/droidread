# device.just — root and general device state checks shared by the other modules.

adb := env('DROIDREAD_ADB', 'adb')

# Confirm su actually works (Magisk) before anything else in this justfile bothers trying.
# `adb root` itself fails on a production build ("adbd cannot run as root") — that is
# expected and not the real check; `su -c id` returning uid=0 is.
root-check:
    #!/usr/bin/env bash
    set -euo pipefail
    out=$({{adb}} shell "su -c id" 2>&1) || true
    if echo "$out" | grep -q "uid=0"; then
      echo "root: OK ($out)"
    else
      echo "root: NOT AVAILABLE — $out" >&2
      exit 1
    fi

# Wake the screen (accessibility-tree tools in the main CLI need it unlocked too).
wake:
    {{adb}} shell input keyevent KEYCODE_WAKEUP

# Is a call currently active? (MODE_IN_COMMUNICATION). Read-only, used before any capture
# test — every result this session that mattered was cross-checked against this.
call-active:
    @{{adb}} shell dumpsys audio 2>/dev/null | grep -m1 "Mode: MODE" || echo "no audio mode reported"

# One JPEG frame of the current screen, saved locally. Same intent as droidread_screenshot
# in the MCP server, as a plain shell recipe.
screenshot out='screen.jpg':
    {{adb}} exec-out screencap -p | ffmpeg -y -loglevel error -i pipe:0 -vf scale=540:-2 -q:v 6 "{{out}}"
    @echo "-> {{out}}"

# SELinux mode. Enforcing means root still can't chmod some app-private files — this is
# the real reason db.just streams via `su -c base64` instead of chmod + adb pull.
selinux:
    @{{adb}} shell getenforce
