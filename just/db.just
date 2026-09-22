# db.just — read Messenger's own on-disk database directly, via root.
#
# WHY THIS EXISTS: the accessibility-tree path (droidread's main TypeScript tool) reads
# what is currently rendered on screen, one scroll at a time — proven this session to cost
# ~2.4s per dump and to be vulnerable to fling overshoot. With root, the actual SQLite file
# Messenger writes to disk is directly readable: one query returned 2030 messages and 114
# threads' true first messages, instantly, complete, with no UI interaction at all.
#
# GROUND TRUTH, established live on this device:
#   package         com.facebook.orca
#   db dir          /data/data/com.facebook.orca/databases/
#   main db         msys_database_<acct-id>            — SQLite, container unencrypted
#   thread names    view _unified_thread_name(thread_name, thread_key)
#   messages        table messages(thread_key, timestamp_ms, text, sender_id, ...)
#   E2E-encrypted   secure_message_* / advanced_crypto_transport_* — "Secret Conversations"
#                   only; genuinely encrypted (Signal-protocol terms: sender_key, pre_keys).
#                   Normal chats are NOT in this family and are plaintext on disk.
#
# THE ONE TRAP: `chmod` on the db file fails even as root — SELinux (Enforcing), not a
# real permission wall. `adb pull` after chmod therefore fails too. The fix used
# everywhere below: never chmod, never adb-pull directly — stream the bytes out through
# `su -c base64` and decode locally. Confirmed working; the file opens as real SQLite.

adb := env('DROIDREAD_ADB', 'adb')
out := env('DROIDREAD_HOME', env('HOME') + '/.droidread') + '/root-extracts/messenger'
pkg := 'com.facebook.orca'

# Find this account's actual msys_database filename on-device (the numeric suffix is
# account-specific — never hardcode it).
_dbname:
    #!/usr/bin/env bash
    set -euo pipefail
    {{adb}} shell su -c "ls /data/data/{{pkg}}/databases/ 2>/dev/null" \
      | tr -d '\r' | grep -E '^msys_database_[0-9]+$' | head -1

# Pull the main db plus its WAL/SHM (the WAL holds the newest not-yet-checkpointed rows —
# skip it and recent messages are silently missing). Streams via base64; never chmods.
pull:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{out}}"
    name=$(just db::_dbname)
    if [ -z "$name" ]; then echo "could not find msys_database_* — is Messenger installed and root working? (just device::root-check)" >&2; exit 1; fi
    echo "pulling $name (+ -wal, -shm)…"
    for suffix in "" "-wal" "-shm"; do
      f="${name}${suffix}"
      {{adb}} shell su -c "base64 -w0 '/data/data/{{pkg}}/databases/$f' 2>/dev/null" > "{{out}}/$f.b64"
      base64 -d "{{out}}/$f.b64" > "{{out}}/$f"
      rm -f "{{out}}/$f.b64"
      echo "  $f: $(stat -c%s "{{out}}/$f" 2>/dev/null || echo 0) bytes"
    done
    ln -sf "$name" "{{out}}/current.db"
    echo "-> {{out}}/current.db"

# Every table name, so you can find what you need beyond the ones documented above.
tables: pull
    sqlite3 "{{out}}/current.db" ".tables"

# Every named thread (group or DM), alphabetical. This is the full 179-thread list read
# live this session.
threads: pull
    sqlite3 -separator ' | ' "{{out}}/current.db" \
      "SELECT thread_name FROM _unified_thread_name WHERE thread_name IS NOT NULL AND thread_name != '' ORDER BY thread_name"

# True first (oldest) text message in every thread, oldest-thread-first. Deduplicated with
# ROW_NUMBER() — a naive MIN(timestamp_ms) join double-counts threads with two messages
# tied on the same millisecond, which is how this was first run and had to be fixed.
first-messages: pull
    #!/usr/bin/env bash
    set -euo pipefail
    sqlite3 -separator '	' "{{out}}/current.db" "
    WITH ranked AS (
      SELECT m.thread_key, m.timestamp_ms, m.text,
        ROW_NUMBER() OVER (PARTITION BY m.thread_key ORDER BY m.timestamp_ms ASC, m.rowid ASC) AS rn
      FROM messages m WHERE m.text IS NOT NULL AND m.text != ''
    )
    SELECT COALESCE(n.thread_name, '(unnamed DM #' || r.thread_key || ')'),
           datetime(r.timestamp_ms/1000, 'unixepoch', 'localtime'),
           replace(r.text, char(10), ' | ')
    FROM ranked r LEFT JOIN _unified_thread_name n ON n.thread_key = r.thread_key
    WHERE r.rn = 1 ORDER BY r.timestamp_ms ASC"

# Most recent N messages across every thread (default 50), newest last.
recent n='50': pull
    sqlite3 -separator '  ' "{{out}}/current.db" \
      "SELECT datetime(m.timestamp_ms/1000,'unixepoch','localtime'), COALESCE(n.thread_name,'#'||m.thread_key), replace(m.text,char(10),' | ') \
       FROM messages m LEFT JOIN _unified_thread_name n ON n.thread_key = m.thread_key \
       WHERE m.text IS NOT NULL AND m.text != '' ORDER BY m.timestamp_ms DESC LIMIT {{n}}"

# Full-text search across every message, every thread. Case-insensitive substring.
search q: pull
    sqlite3 -separator '  ' "{{out}}/current.db" \
      "SELECT datetime(m.timestamp_ms/1000,'unixepoch','localtime'), COALESCE(n.thread_name,'#'||m.thread_key), replace(m.text,char(10),' | ') \
       FROM messages m LEFT JOIN _unified_thread_name n ON n.thread_key = m.thread_key \
       WHERE m.text LIKE '%{{q}}%' ORDER BY m.timestamp_ms DESC"

# Row counts: total messages, distinct threads with any message, threads with a name.
stats: pull
    #!/usr/bin/env bash
    set -euo pipefail
    db="{{out}}/current.db"
    echo "messages:        $(sqlite3 "$db" 'SELECT COUNT(*) FROM messages')"
    echo "threads w/ msgs: $(sqlite3 "$db" 'SELECT COUNT(DISTINCT thread_key) FROM messages')"
    echo "named threads:   $(sqlite3 "$db" "SELECT COUNT(*) FROM _unified_thread_name WHERE thread_name IS NOT NULL AND thread_name != ''")"

# Open a raw sqlite3 shell on the pulled copy, for anything not covered above.
shell: pull
    sqlite3 "{{out}}/current.db"

# Remove the local pulled copy. The on-device original is untouched either way.
clean:
    rm -rf "{{out}}"
