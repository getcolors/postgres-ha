# postgres-ha

A tri-colour Package Skill (green, red, blue) that provisions a three-node
PostgreSQL failover cluster on DigitalOcean, with point-in-time recovery to
Cloudflare R2 and a restore that is verified on a schedule rather than
assumed.

```sh
npx skills add getcolors/postgres-ha
cp .agents/skills/package-postgres-ha-green/green ./green
./green build
./green create --dry-run
./green create
```

The same package ships as `package-postgres-ha-red` (TypeScript/Bun) and
`package-postgres-ha-blue` (Python/uv); the three launchers accept the same
verbs against the same `colors.yml` and render byte-identical trees.

## What it builds

Three `s-2vcpu-4gb` droplets in one region's default VPC, discovered rather
than configured, and on them:

- **PostgreSQL 17** — one primary, two hot standbys, physical streaming
  replication with replication slots and quorum synchronous commit
  (`ANY 1`), so an acknowledged transaction is durable on at least two
  machines and a failover loses nothing.
- **Patroni 4.1.5** over a colocated **three-member etcd 3.5.33** — one process
  owning `postgresql.conf`, `pg_hba.conf`, the slots, the leader lock and the
  promotion decision.
- **HAProxy** on every node, health-checking Patroni's REST API. Port 5432
  reaches whichever node currently holds the leader lock; 5433 reaches the
  standbys.
- **pgBackRest 2.59** to an R2 bucket — a daily full backup and continuous WAL
  archiving, both leader-gated so the schedule follows a failover by itself.
- A **verified restore** every day on a standby, and an archive-continuity
  heartbeat that gives it something real to check.

## The client endpoint

`cluster-host` resolves to all three nodes as DNS-only A records. Each node's
HAProxy forwards to the current primary, so every address is a correct answer
while its node is up — and libpq tries each resolved address in turn, so a node
that is down is skipped by the client. **Nothing is rewritten during a
failover**: no DNS call, no cloud API call, no credential needed at the moment
the cluster is degraded.

```sh
psql "host=pg-ha.example.com port=5432 user=postgres dbname=appdb connect_timeout=5"
psql "host=pg-ha.example.com port=5433 user=postgres dbname=appdb connect_timeout=5"
```

**`connect_timeout` is required, not decoration.** A node that is powered off
black-holes the connection rather than refusing it, and libpq's default is to
wait out the OS TCP retry — about two minutes — before trying the next address
in the set. With it set, one dead node costs at most that timeout on the
connections that happen to resolve it first, and none fail. Measured on a live
cluster with a node powered off: 6 of 10 probes in ~80 ms, 4 in ~5.1 s, zero
failures.

## Operating it

```sh
./green status                    # patronictl list
./green switchover                # planned handover
./green failover --node 2         # unplanned, dispatched through a live node
./green backup                    # full backup now, on the leader
./green verify-restore            # verified restore now, on a standby
./green psql                      # a session on the current primary
```

The verbs reach the nodes through the `~/.ssh/config` aliases the local stage
writes — `<profile>` for node 1 and `<profile>-0`, `<profile>-1`, `<profile>-2`
for each node, the Compute Cluster Standard's names, which replaced the
`<profile>-1..3` aliases the package wrote before it adopted the standard.

The deployment owns its SSH keypair (the workspace SSH Keypair Standard,
keygen mode): with no `digitalocean-ssh-keys` in `colors.yml`, the first real
`create` generates `~/.ssh/<profile>` and `~/.ssh/<profile>.pub`, registers
the public key at DigitalOcean under the profile's name, names it in the
`~/.ssh/config` block, and `delete` removes the key last, after the droplets
are gone. Supplying `digitalocean-ssh-keys` (and then
`digitalocean-ssh-private-key`, the path to its private half) opts out: the
package uses the listed key and touches no key material.

## Recovery

See [Recovery](skills/package-postgres-ha-green/references/configuration.md#recovery)
for the full procedure. In short: a lost standby is re-cloned by Patroni with
no operator action; a lost primary is promoted automatically within roughly
`patroni-ttl` seconds; and a lost cluster is rebuilt from R2 with
`pgbackrest restore`, optionally to a chosen point in time.

## Development

```sh
cd green && bb test && bb golden      # canonical Clojure implementation
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh                   # three colours, two backends, byte for byte
./scripts/launcher.sh
```

Desired state is `colors.yml`; credentials are `COLORS_PAR_*` values sourced
from a gitignored `.envrc.private`. Never set `COLORS_PAR_PROFILE`.

MIT licensed.
