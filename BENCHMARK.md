# BENCHMARK.md

Running log for the `postgres-ha` / `postgres-ha-digitalocean` benchmark run.
Written while the work happens, not reconstructed afterwards. Timestamps are
ISO-8601, local timezone `+02:00`, on host `ubuntu` (Linux 6.17, nix profile).

## Phase: design — 2026-08-16T09:33:40+02:00

Entered after reading, in order: workspace `CLAUDE.md`;
`skills/create-package-skill/SKILL.md`; `clickhouse/` (only multi-node package,
Hetzner); `vaultwarden/` (R2 replication + scheduled restore verification);
`k8s/` (multi-node DigitalOcean, own OpenTofu template, own provider registry,
`operator.clj` SSH dispatch); `temporal/` (newest DigitalOcean package,
runtime VPC discovery, Cloudflare DNS stage); the `green` SDK namespaces
`cli`, `lifecycle`, `providers`, `scaffold`, `tofu`, `ansible`; ONCE's provider
registry and its `digitalocean` / `cloudflare` templates.

`mysql-ha/` and `mysql-ha-digitalocean/` were not read, referenced, or listed
beyond the single `ls` of the workspace root that shows every checkout.

### Fixed inputs (not decisions)

Three droplets max, `s-2vcpu-4gb`, `ubuntu-24-04-x64`, `ams3`, VPC discovered
at runtime, endpoint `pg-ha.bigconfig.website` in zone `bigconfig.website`,
backups to existing R2 bucket `postgres-ha-backup`, exactly two database
credentials (`COLORS_PAR_POSTGRES_ADMIN_PASSWORD`,
`COLORS_PAR_POSTGRES_REPLICATION_PASSWORD`), no `.github/workflows/`.

### Decisions, with the reasoning that is not in any existing repository

Recorded here in short form; `plans/0001-postgres-ha-v1.md` carries the full
argument and the rejected alternatives.

1. **Replication topology** — one primary, two hot standbys, physical
   streaming replication, `synchronous_standby_names = ANY 1 (...)` (quorum
   commit). Three nodes is exactly the budget where quorum-of-one gives
   zero-data-loss failover while still tolerating one node loss.
2. **Failover orchestrator** — Patroni, with etcd v3 as the DCS. Patroni is the
   only widely deployed orchestrator that owns `postgresql.conf`, the
   `pg_rewind`/`pg_basebackup` reattachment path and the leader lock in one
   process.
3. **Quorum store** — a three-member etcd cluster colocated on the same three
   droplets, bound to the VPC private addresses. Explicitly permitted by the
   brief; no fourth machine tier. Patroni 4 removed `raft` as a DCS, so
   "Patroni without a separate store" is not on the table.
4. **Client endpoint** — HAProxy on all three nodes in TCP mode, health-checking
   Patroni's REST API (`/primary` for `:5432`, `/replica` for `:5433`), plus
   **three** Cloudflare DNS-only `A` records for `pg-ha.bigconfig.website`.
   libpq resolves the name and tries every returned address in turn, so a dead
   node is skipped by the client without any DNS or cloud-API mutation during a
   failover. Rejected: DigitalOcean Reserved IP reassigned from a Patroni
   `on_role_change` callback — it works, but it puts a write-scoped
   DigitalOcean API token on every database node and makes the endpoint depend
   on a control-plane API call at the exact moment the cluster is degraded.
5. **Backup tool** — pgBackRest, `repo1-type=s3` against R2. Daily full backup,
   leader-gated by a `systemd` timer.
6. **PITR mechanism** — pgBackRest WAL archiving:
   `archive_command = pgbackrest --stanza=main archive-push %p`, `archive_mode
   = on`, set through Patroni's DCS so every node carries it and a promoted
   standby keeps archiving without reconfiguration.
7. **Verified restore** — a `systemd` timer on each node that only fires when
   that node is a *replica*: `pgbackrest restore` of the latest backup into a
   scratch directory, a throwaway cluster started on a spare port with
   `recovery_target = immediate`, a sentinel-table checksum compared against
   the value the live primary recorded, then teardown. Success writes an
   ISO-8601 timestamp to `/var/lib/postgresql/.postgres-ha-restore-check`.
   Acceptance reads that file.

   **Amended during implementation** (recorded here rather than rewritten,
   because the reason it changed is the finding). `recovery_target = immediate`
   stops at the end of the *backup*, so the check would have proved the backup
   restorable while never touching a single archived WAL segment — it would
   have passed with archiving broken. And the "compare against the live
   primary" step needed a password, because a standby can only reach the
   primary over TCP. Both problems dissolve together: recovery now runs to the
   end of the WAL stream, and a leader-written heartbeat row a minute gives the
   check something it can compare *locally*, by peer authentication, with no
   credential at all. See decision 9.
9. **Archive-continuity heartbeat.** A one-row-per-minute insert by whichever
   node holds the leader lock. The verified restore asserts that the restored
   copy contains a heartbeat younger than `restore-check-max-lag-seconds`
   (default 900), which is what turns "WAL is archived continuously" from a
   configuration claim into a tested one.
8. **No new credential.** Patroni's REST API and etcd's client/peer ports are
   protected by the DigitalOcean firewall (VPC-only) rather than by an API
   password or etcd RBAC, precisely because adding either would have required a
   credential the brief does not supply. This is a deliberate, documented
   trade-off, not an oversight.

### External components this topology installs

Versions are pinned in `colors.yml` and asserted by `bb golden`; the exact
values as first written are listed under the "compute stage" entry below and
updated in place if a pin has to move.

## Phase: package scaffold — 2026-08-16T09:36:00+02:00

Wrote `postgres-ha/` from scratch: five library namespaces, ten OpenTofu and
Ansible template resources, nine scheduled-work templates, the launcher
payload, `bb pin`, the golden and launcher scripts, and 49 unit tests.

Structural references used: `k8s/` for the shape (green-only, own provider
registry, own DigitalOcean template, `operator.clj` SSH dispatch, `load-infrastructure`
before delete), `temporal/` for runtime VPC discovery and the Cloudflare stage,
`clickhouse/` for the multi-node inventory and the `bb golden` safety
assertions, `vaultwarden/` for the shape of a scheduled restore verification.
Nothing was copied wholesale; the topology has no precedent here.

### External components, with versions

| Component | Version | Source | Pinned how |
|---|---|---|---|
| PostgreSQL | 17 (major) | PGDG apt, `noble-pgdg` | major version; patches inside a major release are security updates |
| Patroni | 4.1.5-1.pgdg24.04+1 | PGDG apt | full Debian version, then `dpkg --set-selections hold` |
| pgBackRest | 2.59.0-1.pgdg24.04+1 | PGDG apt | full Debian version, then held |
| etcd | v3.5.33 | GitHub release tarball | version **and** SHA-256 of the linux-amd64 tarball |
| HAProxy | 2.8 series | Ubuntu noble | series asserted after install; deliberately unpinned so security updates apply |
| python3-etcd | noble | Ubuntu noble | Patroni's etcd3 DCS dependency |

etcd v3.5.33 was chosen over the newer v3.6/v3.7 lines: it is the line Patroni 4
is most widely run against, and this deployment has one shot at converging.
Patroni 4 removed the `raft` DCS, so running Patroni without a separate store
was not an option.

### Failed checks in this phase

1. **`./green build`, attempt 1 — `template not found on classpath:
   io/github/getcolors/postgres-ha/tools/infrastructure/main.tf`.**
   `green.scaffold/template-path` turns a keyword namespace's dots into slashes
   but does *not* munge hyphens to underscores the way Clojure does for source
   files. The resource tree had been created as `postgres_ha/` to match
   `src/clj/`. Fixed by renaming the resource directory to `postgres-ha/`,
   which is the name the keyword namespace actually produces. One attempt.
   This is a real trap for any package whose name contains a hyphen; every
   existing package in this workspace has a single-word name, so no precedent
   covered it.
2. **`bb test`, attempt 1 — 1 failure of 191 assertions.** My own test asserted
   `:patroni-synchronous-node-count 2` was refused; the validator allows 1..2
   and refuses 3. The validator was right — requiring two acknowledgements is a
   defensible stricter durability bar that Patroni can still degrade from, and
   only requiring *all three* leaves a cluster that cannot lose a node. Fixed
   the test, not the validator. One attempt.
3. **`./scripts/launcher.sh`, attempt 1 — "the launcher carries package logic:
   patronictl".** The forbidden-substring guard matched the word `patronictl`
   in the launcher's *usage text*. Naming a tool in help output is
   documentation; running one is logic. Replaced the substring list with
   patterns that describe running a tool (`babashka.process`, `ProcessBuilder`,
   `"ssh"`, `selmer`, `tofu/`, `defn .*-step`). One attempt.

### Decisions with no precedent in this workspace

- **Two credential pairs for one object store.** `COLORS_PAR_R2_*` keys the
  OpenTofu state bucket; `COLORS_PAR_BACKUP_R2_*` keys the backup bucket.
  Existing packages have only ever needed one. Validation refuses a
  `backup-r2-bucket` equal to `r2-bucket`: a leaked backup key must not be able
  to rewrite the state that describes where the cluster is.
- **A port-collision validator with one deliberate exception.** Seven listeners
  must own distinct ports; `postgres-port` may equal `haproxy-primary-port`
  because PostgreSQL binds only the private VPC address and HAProxy only the
  public address and loopback. That exception is what lets clients use 5432 on
  the endpoint name, and it needed to be encoded rather than left as folklore.
- **The archive-continuity heartbeat.** A row a minute, written only by the
  leader, so that "WAL is being archived continuously" becomes something the
  verified restore can *assert* — it requires the restored copy to contain a
  heartbeat younger than `restore-check-max-lag-seconds`. No existing package's
  restore check distinguishes "the backup restored" from "the WAL written after
  it was archived and replayed".
- **`--archive-mode=off` on the verification restore.** A scratch copy that
  promoted with archiving still enabled would push its own WAL into the shared
  repository on a timeline the real cluster uses, and poison every future
  restore. `bb golden` fails if that flag disappears.

### Checks now passing

- `bb test` — 49 tests, 192 assertions, 0 failures.
- `bb golden` — both backend variants byte-identical, plus 60-odd safety
  assertions (no public bind, no world-open ingress, destroy guard intact, no
  credential-shaped bytes, every scheduled unit both rendered and installed).
- `./scripts/launcher.sh` — 10 checks, including a credential-free build with
  `env -i` and a refused `COLORS_PAR_PROFILE`.

## Phase: repositories and deployment scaffold — 2026-08-16T10:00:00+02:00

- `getcolors/postgres-ha` created public, pushed at `e9a8aaa`, then `bb pin`
  stamped the launcher at that commit and the stamped launcher was pushed as
  `e47cccb`. The pin is a real pushed SHA; `bb pin` refuses a dirty or unpushed
  HEAD, and was allowed to.
- `getcolors/postgres-ha-digitalocean` created public and pushed.
- The Package Skill was installed with `npx skills add getcolors/postgres-ha`,
  which resolved from GitHub and wrote a genuine `skills-lock.json`
  (`computedHash ce4a1dc9…`). The root `./green` is a byte-identical **copy** of
  `.agents/skills/package-postgres-ha-green/green`, verified with `cmp`.
- `./green build` in the deployment cloned `postgres-ha` at
  `e9a8aaa2c30dad96f015935679b8ef8168bff4ca` and rendered the whole tree, which
  proves the pinned launcher resolves without any working-tree override.
- Fresh-directory check: `colors.yml` plus `./green` alone, run under
  `env -i PATH HOME`, both `build` and `create --dry-run` succeed. No
  credential is needed for either.

### Anything needed and not available

Nothing so far. Every credential the design calls for was already present:
`COLORS_PAR_DO_TOKEN`, `COLORS_PAR_CLOUDFLARE_API_TOKEN`, both R2 pairs and the
two database passwords. The design was shaped to need exactly those — see the
heartbeat decision, which exists because a third credential was not available.

## Phase: real deploy — 2026-08-16T10:10:00+02:00

`./green create` against DigitalOcean `ams3`, Cloudflare zone
`bigconfig.website`, and the R2 bucket `postgres-ha-backup`.

### Failure 4 — `./green create`, cluster stage, attempt 1 (2026-08-16T10:14)

`dpkg_selections` failed on two of three nodes: *"dpkg frontend lock was locked
by another process"*. A freshly created DigitalOcean droplet is still running
cloud-init and unattended-upgrades when Ansible's first apt task arrives, and
the first one there loses a race it does not know it is in.

Fixed with two changes: a `cloud-init status --wait` before any package task,
and `lock_timeout: 300` on both `apt` tasks. `dpkg_selections` has no
`lock_timeout`, so that one retries (`until: held is not failed`, 30×10s).
One attempt to fix. Golden diff inspected line by line before `bb golden:accept`
— it contained exactly those four hunks and nothing else.

### Failure 5 — `./green create`, cluster stage, attempt 2 (2026-08-16T10:21)

The play reached task 30 of 41 and then spent 90 retries × 5s failing *"Wait
for one leader and 3 running members"* — while the cluster it was waiting for
was already correct on the very first attempt.

The gate required all three members to report `state == "running"`. Patroni
reports the leader as `running` and a healthy streaming standby as
`streaming`; and with synchronous mode on, the roles are `leader`, `replica`
and `sync_standby` rather than two identical `replica`s. My condition was
written from an idea of Patroni's vocabulary rather than from its output.

The captured JSON from the last failed attempt is itself the evidence the
cluster was fine:

```
postgres-ha-1  leader        running    TL 1
postgres-ha-2  replica       streaming  TL 1  lag 0
postgres-ha-3  sync_standby  streaming  TL 1  lag 0
```

Cost: the whole 7.5-minute retry budget, and every task after the gate —
database bootstrap, `stanza-create`, first backup, HAProxy, the three timers
and the verified restore — did not run.

This is the failure worth reading in this log. Nothing was wrong with the
topology, the credentials, or the infrastructure; the health check was wrong,
and a health check that is wrong in the *pessimistic* direction costs a whole
converge. The `sync_standby` role only exists because quorum synchronous commit
was chosen, so the design decision and the bad assertion are the same decision
seen twice.

### Failure 6 — `./green create`, acceptance stage, attempt 3 (2026-08-16T14:14)

The converge itself succeeded — cluster stage green, database bootstrapped,
stanza created, first backup taken, HAProxy up, timers enabled, verified
restore run on both standbys. Acceptance then failed 2 of its 10 checks, and
**both were wrong checks rather than wrong infrastructure**.

1. *"WAL archiving is not healthy: archived=17
   last_failed=000000010000000000000001"*. `pg_stat_archiver.last_failed_wal`
   is sticky — it names the last segment that ever failed, not a current
   problem — and it is *expected* to be set on a newly built cluster. Patroni
   bootstraps with `archive_mode = on`, so PostgreSQL starts retrying the first
   segment several minutes before `pgbackrest stanza-create` can run, which
   cannot happen until the cluster is up and the gate has passed. 690 retries
   of segment 1 accumulated in that window.

   No WAL was lost: PostgreSQL retries a segment forever rather than skipping
   it, and `pgbackrest info` reports `archive_min =
   000000010000000000000001`. The check now asserts the thing that actually
   means healthy — `last_archived_time > last_failed_time`, plus a last
   success within the hour — and a new check asserts the repository's archive
   range is unbroken from the cluster's first segment, which is what turns the
   retry storm from a worry into a footnote. The retry count is still printed,
   because hiding it would be the wrong kind of green.

2. *"no node recorded a successful verified restore"* — while both standbys had
   in fact recorded one. The helper stopped at the first node that answered
   SSH, which is the leader, where the stamp file correctly does not exist. A
   per-node fact was being asked of the cluster. Added `on_each_node` and made
   the check collect every stamp and report the newest.

One attempt each. Both were fixed in the package, `bb golden` diff inspected
hunk by hunk, then accepted.

## Real deploy converged — 2026-08-16T14:20:00+02:00

`./green create` exit 0. 11 acceptance checks, 0 failures, all asserted from
outside the cluster over the same endpoint and SSH aliases an operator uses.

```
pg-ha.bigconfig.website resolves to all 3 nodes
  159.223.218.57 161.35.145.85 64.225.65.170
port 5432 reaches a read-write primary
  PostgreSQL 17.11 (Ubuntu 17.11-1.pgdg24.04+2) on postgres-ha
port 5433 reaches a read-only standby
Patroni reports 3 healthy members and exactly 1 leader
  postgres-ha-1 Leader running | postgres-ha-2 Replica streaming | postgres-ha-3 Sync Standby streaming
2 standbys are streaming from the primary
1 standby acknowledges synchronously
  synchronous_standby_names = "postgres-ha-3"
WAL archiving is continuous: 23 segments archived, last attempt succeeded
  archive_command = pgbackrest --stanza=main archive-push %p
  archive_timeout = 1min
the backup repository holds 1 backup(s) and WAL from ...0001 to ...0014
  full 20260816-121053F size=3708197B
the archive is unbroken from the cluster's first WAL segment
the verified restore passed on 2 node(s), most recently 0h ago
  2026-08-16T12:19:18Z restored=... rows=8 lag=44s node=postgres-ha-2
  2026-08-16T12:20:04Z restored=... rows=9 lag=60s node=postgres-ha-3
a row written through port 5432 was readable on port 5433
```

Live infrastructure, all in `ams3`, all named for this deployment:
`postgres-ha-1` 161.35.145.85 / 10.133.0.7, `postgres-ha-2` 64.225.65.170 /
10.133.0.5, `postgres-ha-3` 159.223.218.57 / 10.133.0.6.

Total wall-clock for a converge on already-created droplets: 2m38s for the
cluster stage, 8s for acceptance. From nothing, roughly 8 minutes.

## Phase: failover — 2026-08-16T14:21:00+02:00

A real, unplanned failover: the leader droplet was powered off through the
DigitalOcean API. Not a `switchover`, not `systemctl stop patroni` — the
machine was taken away.

Before (12:21:01 UTC): `postgres-ha-1` Leader on TL 1, `postgres-ha-2` Replica,
`postgres-ha-3` Sync Standby. A marker row was written through
`pg-ha.bigconfig.website:5432` and served by `10.133.0.7`
(`id=12, token=failover-marker`).

```
12:21:06  postgres-ha-3 still following leader postgres-ha-1
12:21:11  power-off issued for droplet 592774454 (name verified == postgres-ha-1)
12:21:15  postgres-ha-3: "promoted self to leader by acquiring session lock"
12:21:22  DigitalOcean reports power-off completed
```

Promotion happened within ~9s of the last healthy observation, well inside the
30s `patroni-ttl`.

After:

```
postgres-ha-2  10.133.0.5  Sync Standby  streaming  TL 2  lag 0
postgres-ha-3  10.133.0.6  Leader        running    TL 2
```

- `pg-ha.bigconfig.website:5432` serves `10.133.0.6`, `pg_is_in_recovery = f`.
  The DNS records were not touched; no cloud API was called.
- The marker row written before the failover is present. **No acknowledged
  transaction was lost** — which is what quorum synchronous commit was chosen
  for, and it is now a measurement rather than a claim.
- `synchronous_standby_names` is now `"postgres-ha-2"`: Patroni re-established
  quorum durability against the one remaining standby by itself.
- The leader-gated heartbeat timer followed the leader with no intervention;
  writes resumed on the new primary.

### The one thing the design got wrong, found by doing this

With the leader's droplet **powered off**, its address does not refuse
connections — it black-holes the SYN. libpq's default `connect_timeout` is
unset, so it waits out the OS TCP retry (~130s) on that address before trying
the next one in the record set. The first probe after the failover hit the dead
address and hung; a 30s timeout killed it.

Measured, 10 probes through the endpoint with one dead node still in the
record set and `connect_timeout=5`:

```
6 probes:  ~80ms    (a live address resolved first)
4 probes:  ~5090ms  (dead address first, bounded, then the next one)
all 10:    reached a writable primary
```

glibc rotates the returned addresses, so roughly one connection in three pays
the penalty while a node is down, and none fail.

So the three-A-record endpoint needs **one** libpq parameter — `connect_timeout`
— to behave correctly against total node loss. That is a real cost of the
choice and it is now in `plans/0001`, the SKILL, the configuration reference,
both READMEs, and an acceptance check, rather than being discovered by whoever
is on call. It is still meaningfully cheaper than the `target_session_attrs`
alternative that was rejected: `connect_timeout` is a timeout, understood by
every driver, and requires no knowledge of Patroni, roles, or which node is
primary. Note also that this only bites on total node loss — a crashed
PostgreSQL, a stopped Patroni or a rebooting service leaves the node's HAProxy
answering, and the endpoint never pauses at all.

### The old primary rejoining — 2026-08-16T14:38

Powered back on through the API; no other action taken. It came back as a
`Replica` on timeline 2 in state `in archive recovery`, 160 MB behind — it was
fetching the WAL it had missed **from the pgBackRest repository** through the
`restore_command` set in Patroni's DCS, not from the new leader. That setting
existed for exactly this and it is pleasant to watch it earn its place. It then
caught up and reached `streaming` with zero lag:

```
postgres-ha-1  10.133.0.7  Replica       streaming  TL 2  lag 0
postgres-ha-2  10.133.0.5  Sync Standby  streaming  TL 2  lag 0
postgres-ha-3  10.133.0.6  Leader        running    TL 2
```

The cluster is back to full redundancy on the new timeline with the leader on a
different machine than it started on, which is the correct end state — nothing
fails back.

### Closing the gap the failover exposed

Rather than documenting around it:

- `client-connect-timeout-seconds` is now a required, range-validated key
  (1..30, default 5) — desired state, not advice in a README, because the two
  would drift.
- The acceptance script uses it for its own connections, and gained a check
  that probes the endpoint `3 × nodes` times and requires every probe to reach
  a read-write primary within `connect_timeout × (nodes − 1) + 10s`. Probing
  once proves nothing: glibc rotates the resolved order, so a single probe may
  never touch the address that would have hung.
- `bb golden` fails if either disappears.
- The measurement is written into `plans/0001`, `SKILL.md`, the configuration
  reference and both READMEs.

