# droidread — task runner for the root-level capabilities built alongside the main
# TypeScript tool: reading Messenger's own database directly, the frida instrumentation
# path explored against LINE, and the two standalone Android apps (callit, linevoice).
#
# The TypeScript CLI (`bun src/cli.ts`) and MCP server are the primary, portable, no-root
# interface — see README.md. Everything here is root-only, device-specific, and grew out
# of hands-on exploration in one session; it is recorded so it is reproducible, not because
# it is meant to replace the accessibility-tree path for anyone without root.
#
# Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan. Every recipe here acts only on
# the operator's own device over their own authorised adb connection.

set shell := ["bash", "-uc"]

# Path to adb. Same override convention as the rest of droidread.
adb := env('DROIDREAD_ADB', 'adb')
# Where extracted database copies land. Same privacy posture as ~/.droidread: outside any
# repo, gitignored, never committed.
data_dir := env('DROIDREAD_HOME', env('HOME') + '/.droidread') + '/root-extracts'
# Sibling app projects built during the LINE call-audio investigation.
callit_dir := env('CALLIT_DIR', '../callit')
linevoice_dir := env('LINEVOICE_DIR', '../linevoice')

mod db 'just/db.just'
mod device 'just/device.just'
mod frida 'just/frida.just'
mod apps 'just/apps.just'

# List every recipe, including inside modules.
default:
    @just --list --unsorted
    @echo
    @echo "modules: just db::<recipe>  just device::<recipe>  just frida::<recipe>  just apps::<recipe>"

# Full status sweep: root, device, frida, installed apps, magisk module. Read-only.
status: device::root-check frida::status apps::status
    @echo "--- magisk module ---"
    {{adb}} shell su -c "ls -d /data/adb/modules/linevoice_privapp 2>/dev/null && echo present || echo absent"
