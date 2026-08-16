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

