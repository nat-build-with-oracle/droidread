# bruin.just — run the Bruin-defined messenger pull, on demand.
#
# WHY THIS EXISTS: same pull as db.just's `pull` recipe, but authored as a real Bruin
# pipeline asset (built during a same-day orchestrator comparison — Kestra, Airflow,
# Dagster, Prefect, Mage were all tried too; Bruin was the one purpose-built for pipeline
# *definition* rather than scheduling). No scheduler of its own — this just runs it once,
# on demand, via `docker exec` into the container where it's installed. If it ever needs
# to run unattended, the plan is "Bruin defines it, Kestra runs it" — a Kestra task calling
# `bruin run`, not Bruin replacing Kestra's schedule.
#
# Project lives inside the `bruin-test` container at /root/bruin/messenger-pull. Output
# lands at /tmp/bruin-messenger-pull/current.db INSIDE that container, not on the host —
# `pull` below copies it out to the same host-visible location db.just's own pull uses.

out := env('DROIDREAD_HOME', env('HOME') + '/.droidread') + '/root-extracts/messenger'

# Run the Bruin pipeline for real, then copy its output to the same host path db::pull uses.
pull:
    docker exec bruin-test bruin run /root/bruin/messenger-pull
    mkdir -p "{{out}}"
    docker cp bruin-test:/tmp/bruin-messenger-pull/current.db "{{out}}/current.db"
    docker cp bruin-test:/tmp/bruin-messenger-pull/current.db-wal "{{out}}/current.db-wal" 2>/dev/null || true
    docker cp bruin-test:/tmp/bruin-messenger-pull/current.db-shm "{{out}}/current.db-shm" 2>/dev/null || true
    @echo "-> {{out}}/current.db"

# Show the pipeline's lineage (Bruin's closest equivalent to a "describe" command).
lineage:
    docker exec bruin-test bruin lineage /root/bruin/messenger-pull/assets/python311/asset.py

# Validate the pipeline definition without running it.
validate:
    docker exec bruin-test bruin validate /root/bruin/messenger-pull
