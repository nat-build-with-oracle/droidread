# apps.just — build/install the two standalone Android apps built this session, and stage
# the Magisk module that makes linevoice a privileged app.
#
#   callit      minimal ACTION_CALL dialer, `com.nat.callit`
#   linevoice   audio-capture probe, `com.nat.linevoice` — CAPTURE_AUDIO_OUTPUT once staged
#
# Both are plain Gradle/Kotlin projects with a real `gradlew` (generated 2026-09-22 from
# the same gradle-8.7 used to build them all session, `gradle wrapper --gradle-version
# 8.7`) — no separately-cached gradle binary needed to build them from here.
#
# THE TWO TRAPS THAT COST REAL TIME BUILDING THESE, recorded so they are not re-discovered:
#   1. JAVA_HOME must point at a full JDK (`apt install openjdk-21-jdk`), not just the JRE
#      that ships by default — AGP's jlink step needs jlink, which the JRE-only package
#      does not have, and the failure ("jlink executable ... does not exist") does not say
#      that plainly.
#   2. The Gradle daemon's own process-spawn call fails in this sandbox ("Failed to exec
#      spawn helper") — every recipe below runs with --no-daemon and an explicit
#      -Djdk.lang.Process.launchMechanism=VFORK, which is what actually worked.

adb := env('DROIDREAD_ADB', 'adb')
# NOTE: bare '../callit' is wrong here — a module recipe's cwd is the MODULE FILE's own
# directory (just/), not the root justfile's directory, so a relative '../' resolves one
# level short. justfile_directory() stays anchored to the root regardless of module
# nesting depth — confirmed by direct test — so anchor off that instead.
callit_dir := env('CALLIT_DIR', justfile_directory() / '../callit')
linevoice_dir := env('LINEVOICE_DIR', justfile_directory() / '../linevoice')
java_home := env('JAVA_HOME', '/usr/lib/jvm/java-21-openjdk-amd64')
android_home := env('ANDROID_HOME', env('HOME') + '/Android/Sdk')
_gradle_flags := '--no-daemon -Dorg.gradle.jvmargs=-Djdk.lang.Process.launchMechanism=VFORK'

# Build + install callit (normal /data/app install — no root needed for this one; it only
# ever uses ACTION_CALL, which needs the ordinary CALL_PHONE runtime permission).
callit-build:
    cd {{callit_dir}} && JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} ./gradlew {{_gradle_flags}} assembleDebug

callit-install: callit-build
    {{adb}} install -r {{callit_dir}}/app/build/outputs/apk/debug/app-debug.apk

# Build linevoice as a plain APK (no privileged permission — CAPTURE_AUDIO_OUTPUT source
# capture will report `false` and fall back to the MediaProjection probe until staged).
linevoice-build:
    cd {{linevoice_dir}} && JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} ./gradlew {{_gradle_flags}} assembleDebug

linevoice-install: linevoice-build
    {{adb}} uninstall com.nat.linevoice 2>/dev/null || true
    {{adb}} install -r {{linevoice_dir}}/app/build/outputs/apk/debug/app-debug.apk

# --- the Magisk privileged-app path: the only way found this session to actually hold
# --- CAPTURE_AUDIO_OUTPUT (signature|privileged — `pm grant` refuses it even as root,
# --- "managed by role"; a systemless priv-app overlay is what actually grants it).

_module_name := 'linevoice_privapp'
_module_work := env('DROIDREAD_HOME', env('HOME') + '/.droidread') + '/root-extracts/module'

# Assemble + stage the module (does NOT reboot — nothing takes effect until you do).
# Includes the enforcement-to-log system.prop safety net: without it, an incomplete
# priv-app allowlist BOOTLOOPS a device with ro.control_privapp_permissions=enforce. With
# it, the worst case is the permission silently not granting. Confirmed live: this device
# is enforce by default, the safety net was included, and the reboot came back clean.
stage-linevoice-module: linevoice-build
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{_module_work}}/system/priv-app/LineVoice" "{{_module_work}}/system/etc/permissions"
    cp {{linevoice_dir}}/app/build/outputs/apk/debug/app-debug.apk "{{_module_work}}/system/priv-app/LineVoice/LineVoice.apk"
    cat > "{{_module_work}}/module.prop" <<'EOF'
    id=linevoice_privapp
    name=LineVoice Privileged Audio Capture
    version=1.0
    versionCode=1
    author=nat
    description=Systemless overlay: installs com.nat.linevoice as a priv-app and allowlists CAPTURE_AUDIO_OUTPUT. Remove this module and reboot to fully revert.
    EOF
    cat > "{{_module_work}}/system/etc/permissions/privapp-permissions-com.nat.linevoice.xml" <<'EOF'
    <?xml version="1.0" encoding="utf-8"?>
    <permissions>
        <privapp-permissions package="com.nat.linevoice">
            <permission name="android.permission.CAPTURE_AUDIO_OUTPUT"/>
        </privapp-permissions>
    </permissions>
    EOF
    echo "ro.control_privapp_permissions=log" > "{{_module_work}}/system.prop"
    cat > "{{_module_work}}/_stage.sh" <<'SH'
    #!/system/bin/sh
    MODROOT=/data/adb/modules/linevoice_privapp
    if [ -d "$MODROOT" ]; then mv "$MODROOT" "$MODROOT.old.$(date +%s)"; fi
    cp -a /data/local/tmp/linevoice_privapp "$MODROOT" || { echo cp-failed; exit 1; }
    chown -R 0:0 "$MODROOT"
    find "$MODROOT" -type d -exec chmod 755 {} \;
    find "$MODROOT" -type f -exec chmod 644 {} \;
    echo staged-ok
    SH
    {{adb}} shell "test -d /data/local/tmp/linevoice_privapp && mv /data/local/tmp/linevoice_privapp /data/local/tmp/linevoice_privapp.old.$(date +%s) || true"
    {{adb}} push "{{_module_work}}" /data/local/tmp/linevoice_privapp >/dev/null
    {{adb}} push "{{_module_work}}/_stage.sh" /data/local/tmp/stage_module.sh >/dev/null
    {{adb}} shell su -c "sh /data/local/tmp/stage_module.sh"
    {{adb}} uninstall com.nat.linevoice 2>/dev/null || true
    echo
    echo "staged. enforcement is set to 'log' (bootloop-safe). Reboot to apply:"
    echo "  {{adb}} reboot"
    echo "then re-enable Wireless Debugging by hand if adb was over wifi — it does not survive a reboot."

# Confirm the permission actually landed after a reboot.
verify-capture-permission:
    @{{adb}} shell "dumpsys package com.nat.linevoice" 2>&1 | grep -m1 "CAPTURE_AUDIO_OUTPUT: granted" || echo "not granted — module may not have taken; check just apps::status"

# Fully reversible: remove the module. Nothing on the real system partitions was ever
# touched (all erofs, read-only) — this just stops the systemless overlay from mounting.
unstage-linevoice-module:
    {{adb}} shell su -c "mv /data/adb/modules/{{_module_name}} /data/adb/modules/{{_module_name}}.removed.$(date +%s) 2>/dev/null || echo 'not staged'"
    @echo "reboot to fully revert."

# Both apps' install state + the module's staged/mounted state, in one read-only sweep.
status:
    #!/usr/bin/env bash
    set -euo pipefail
    for pkg in com.nat.callit com.nat.linevoice; do
      p=$({{adb}} shell "pm path $pkg" 2>/dev/null | tr -d '\r')
      echo "$pkg: ${p:-not installed}"
    done
    grant=$({{adb}} shell "dumpsys package com.nat.linevoice" 2>&1 | grep -m1 "CAPTURE_AUDIO_OUTPUT: granted" || true)
    echo "CAPTURE_AUDIO_OUTPUT: ${grant:-not present}"
    staged=$({{adb}} shell su -c "ls -d /data/adb/modules/{{_module_name}} 2>/dev/null" || true)
    echo "magisk module: ${staged:-not staged}"
