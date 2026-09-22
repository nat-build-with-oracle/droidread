# frida.just — bring-up, lifecycle, and cleanup for frida-server on the device.
#
# Used this session to trace LINE's audio path. THE ONE TRAP, learned the hard way:
# `nohup /data/local/tmp/frida-server &` inside a single `adb shell su -c "..."` call does
# NOT actually detach — it dies the moment that adb shell call returns, because it was
# never given its own session. `setsid ... &` inside a pushed script file is what survives
# past the adb call returning; confirmed by checking its PID in a SEPARATE, later adb call.
#
# SECURITY NOTE, stated plainly: frida-server is a root code-execution daemon. `frida-stop`
# exists for a reason — it was left running by accident once this session and had to be
# hunted down. Always stop it when done; never leave it running on a daily-driver phone.
#
# SECOND TRAP, found staging this justfile: `pgrep -f frida-server` / `pkill -f frida-server`
# / `ps -A | grep frida` all self-match. `-f` matches the FULL COMMAND LINE, and the checking
# command's own argv (`su -c "pgrep -f frida-server"`) literally contains the string
# "frida-server" — so it matches itself, every time, giving a false RUNNING even when nothing
# real is alive (confirmed live: three straight "respawns" with new PIDs each check, which
# were actually just fresh pgrep/su/sh invocations matching themselves). Fix: match the
# PROCESS NAME exactly with `-x`, which cannot match a shell named `sh`/`su`/`pgrep`.

adb := env('DROIDREAD_ADB', 'adb')
work := env('DROIDREAD_HOME', env('HOME') + '/.droidread') + '/root-extracts/frida'
version := env('FRIDA_VERSION', '17.18.0')

# Download the matching frida-server build for the device's actual ABI (queried live, not
# assumed — this device is arm64-v8a but another might not be) and push it.
install:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{work}}"
    abi=$({{adb}} shell getprop ro.product.cpu.abi | tr -d '\r')
    case "$abi" in
      arm64-v8a) frida_arch=arm64 ;;
      armeabi-v7a) frida_arch=arm ;;
      x86_64) frida_arch=x86_64 ;;
      x86) frida_arch=x86 ;;
      *) echo "unrecognised abi: $abi" >&2; exit 1 ;;
    esac
    url="https://github.com/frida/frida/releases/download/{{version}}/frida-server-{{version}}-android-${frida_arch}.xz"
    echo "device abi: $abi -> $url"
    curl -sL -o "{{work}}/frida-server.xz" "$url"
    xz -d -f "{{work}}/frida-server.xz"
    chmod +x "{{work}}/frida-server"
    {{adb}} push "{{work}}/frida-server" /data/local/tmp/frida-server
    {{adb}} shell su -c "chmod 755 /data/local/tmp/frida-server"
    echo "installed. run: just frida::start"

# Start it detached (setsid, via a pushed script — see the module header for why a plain
# `nohup &` in one adb call does not survive).
start:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{work}}"
    cat > "{{work}}/start.sh" <<'SH'
    #!/system/bin/sh
    pkill -x frida-server 2>/dev/null
    sleep 1
    setsid /data/local/tmp/frida-server >/data/local/tmp/frida.log 2>&1 &
    sleep 2
    pgrep -x frida-server
    SH
    {{adb}} push "{{work}}/start.sh" /data/local/tmp/frida_start.sh >/dev/null
    {{adb}} shell su -c "sh /data/local/tmp/frida_start.sh"
    echo "started — verifying it survives a fresh adb call:"
    sleep 1
    just frida::status

# Confirmed-dead check: pgrep in a call separate from whatever started it, so a process
# that only *looks* started (but dies when the shell closes) cannot report a false OK.
# `-x` (exact process name), not `-f` (full cmdline) — see the module header trap.
status:
    #!/usr/bin/env bash
    set -euo pipefail
    pids=$({{adb}} shell su -c "pgrep -x frida-server" 2>/dev/null | tr -d '\r' || true)
    if [ -n "$pids" ]; then echo "frida-server: RUNNING (pid(s): $(echo $pids | tr '\n' ' '))"; else echo "frida-server: not running"; fi

# Stop it, then confirm dead with the same self-match-proof check `status` uses.
stop:
    #!/usr/bin/env bash
    set -euo pipefail
    {{adb}} shell su -c "pkill -9 -x frida-server" 2>/dev/null || true
    sleep 1
    left=$({{adb}} shell su -c "pgrep -x frida-server" 2>/dev/null | tr -d '\r' || true)
    if [ -n "$left" ]; then echo "STILL RUNNING (pid(s): $(echo $left | tr '\n' ' '))"; exit 1; else echo "frida-server: stopped (confirmed)"; fi

# List processes on-device via frida — the normal way to find a target PID/name to attach
# `just frida::attach` to.
ps:
    frida-ps -U

# Attach with a given script for a bounded window (default 15s), same pattern used to
# recon LINE's audio path this session. `script` is a path to a .js file.
attach target script seconds='15':
    timeout {{seconds}} frida -U -p {{target}} -l {{script}} -q
