# Configuration and recovery

`colors.yml` is the only file you edit. It is flat, kebab-case, and holds
**non-secret values only**. Every credential arrives as a `COLORS_PAR_*`
environment variable from a gitignored `.envrc.private`.

Validation accumulates: a bad file reports every problem at once with exit 2.

## Credentials

| Variable | Used by |
|---|---|
| `COLORS_PAR_DO_TOKEN` | the DigitalOcean provider |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | the Cloudflare DNS stage |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | the OpenTofu state bucket |
| `COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | the pgBackRest repository |
| `COLORS_PAR_POSTGRES_ADMIN_PASSWORD` | the PostgreSQL superuser |
| `COLORS_PAR_POSTGRES_REPLICATION_PASSWORD` | the replication role |

The two R2 pairs are deliberately separate, and validation refuses a
`backup-r2-bucket` equal to `r2-bucket`: a leaked backup key must not be able
to rewrite the infrastructure state that describes where the cluster is.

**Never set `COLORS_PAR_PROFILE`.** The profile keys the remote state
(`<profile>/<stage>.tfstate`) and the backup repository path. The package
refuses to run when it is set; that is the guard working.

## Keys

### Identity and providers

| Key | Meaning |
|---|---|
| `profile` | names the work directory, the state keys and the SSH aliases |
| `workdir` | generated-output root, `.colors` |
| `provider-compute` | must be `digitalocean` |
| `provider-dns` | must be `cloudflare` |
| `provider-backend` | `local`, `s3` or `r2` |
| `compute-prevent-destroy` | keep `true` in committed desired state |

### Cluster

| Key | Default | Meaning |
|---|---|---|
| `cluster-name` | — | Patroni scope; also the etcd cluster token |
| `cluster-host` | — | the client endpoint, inside `cloudflare-zone` |
| `cluster-nodes` | `3` | fixed at three; see below |
| `postgres-version` | — | PostgreSQL major version, e.g. `17` |
| `postgres-port` | `5432` | bound on the private VPC address only |
| `postgres-database` | — | the application database |
| `postgres-admin-user` | `postgres` | superuser role |
| `postgres-replication-user` | `replicator` | replication role, must differ |

`cluster-nodes` is not a dial. Two members cannot elect, and a fourth machine
is outside this package's design: the quorum store is colocated on exactly
these three.

### Failover

| Key | Default | Meaning |
|---|---|---|
| `patroni-package-version` | — | full Debian version, e.g. `4.1.5-1.pgdg24.04+1` |
| `patroni-rest-port` | `8008` | REST API, bound to the private address |
| `patroni-ttl` | `30` | leader-lock lifetime; the upper bound on failover time |
| `patroni-loop-wait` | `10` | health-check interval |
| `patroni-retry-timeout` | `10` | DCS and PostgreSQL operation retry budget |
| `patroni-synchronous-node-count` | `1` | standbys that must acknowledge a commit |
| `etcd-version` | — | exact release tag, e.g. `v3.5.33` |
| `etcd-sha256` | — | SHA-256 of the linux-amd64 release tarball |
| `etcd-client-port` / `etcd-peer-port` | `2379` / `2380` | private address only |

`patroni-ttl` must exceed twice `patroni-loop-wait`, or the leader lock can
expire between two health checks and the cluster fails over because nothing
went wrong. Lowering `patroni-ttl` shortens the outage during a real failure
and raises the chance of a spurious one; 30 is the upstream default and a good
starting point.

`patroni-synchronous-node-count` may be 1 or 2. At 2, every commit waits for
both standbys — a stricter durability bar that Patroni still degrades from when
one is lost. It may not be 3: that is a cluster that cannot tolerate losing a
node, which is the entire point of having three.

### Client endpoint

| Key | Default | Meaning |
|---|---|---|
| `haproxy-version` | — | distribution series, e.g. `2.8`; asserted after install |
| `haproxy-primary-port` | `5432` | read-write; reaches the current leader |
| `haproxy-replica-port` | `5433` | read-only; reaches a streaming standby |
| `haproxy-stats-port` | `7000` | loopback only |
| `cloudflare-zone` | — | must contain `cluster-host` |
| `cloudflare-proxied` | `false` | must stay false |
| `cloudflare-record-ttl` | `60` | `1` for automatic, otherwise 60..86400 |
| `client-connect-timeout-seconds` | `5` | the `connect_timeout` clients must set |

`haproxy-primary-port` is allowed to equal `postgres-port`, and by default
does: PostgreSQL binds the private VPC address, HAProxy the public address and
loopback, so clients get the standard port on the endpoint name. Every other
port collision is refused.

`cloudflare-proxied: true` is refused rather than accepted and left to fail
later — Cloudflare's proxy speaks HTTP, not the PostgreSQL wire protocol.

`client-connect-timeout-seconds` is desired state rather than advice in a
README because getting it wrong turns a survivable node loss into an outage for
a share of new connections. The endpoint resolves to every node; a node that is
**powered off** black-holes the connection instead of refusing it, and libpq's
default is to wait out the OS TCP retry — about two minutes — before trying the
next address. Every client should connect with it:

```sh
psql "host=pg-ha.example.com port=5432 user=postgres dbname=appdb connect_timeout=5"
```

Measured on a live cluster with one node powered off, ten probes: six reached a
primary in ~80 ms (a live address resolved first), four in ~5.1 s (the dead
address first, bounded, then the next), none failed. glibc rotates the resolved
order, so about one connection in three pays the bound while a node is down.

This only applies to total node loss. A crashed PostgreSQL, a stopped Patroni
or a service restart leaves that node's HAProxy answering and forwarding to the
new leader, and the endpoint never pauses.

### Backups, PITR and verification

| Key | Default | Meaning |
|---|---|---|
| `pgbackrest-package-version` | — | full Debian version, e.g. `2.59.0-1.pgdg24.04+1` |
| `backup-stanza` | `main` | pgBackRest stanza name |
| `backup-oncalendar` | — | systemd `OnCalendar` for the full backup |
| `backup-retention-full` | `4` | full backups kept; WAL is expired with the oldest |
| `backup-r2-bucket` | — | must differ from `r2-bucket` |
| `backup-r2-endpoint` | — | `https://` origin; the scheme is stripped for pgBackRest |
| `backup-r2-region` | `auto` | R2's region |
| `backup-r2-prefix` | — | object-key prefix inside the bucket |
| `heartbeat-oncalendar` | `*:0/1` | archive-continuity heartbeat |
| `heartbeat-retention-days` | `7` | how long heartbeat rows are kept |
| `restore-check-oncalendar` | — | systemd `OnCalendar` for the verified restore |
| `restore-check-port` | `5442` | spare port for the throwaway cluster |
| `restore-check-max-lag-seconds` | `900` | freshness the restored copy must show |
| `restore-check-max-age-hours` | `26` | how stale a passing result may be at acceptance |

`backup-retention-full` bounds the recovery window: WAL older than the oldest
retained full backup is expired with it. Four dailies is roughly a four-day
point-in-time window.

`restore-check-max-lag-seconds` must exceed 120, because a WAL segment is only
archived once `archive_timeout` (60s) elapses; below that the check fails on a
healthy cluster and stops meaning anything.

### DigitalOcean

| Key | Meaning |
|---|---|
| `digitalocean-name` | droplet name prefix; nodes are `<name>-1..3` |
| `digitalocean-region` | region; also selects the default VPC |
| `digitalocean-size` / `-image` | droplet size and image |
| `digitalocean-ssh-keys` | IDs or fingerprints **already registered** on the account |
| `digitalocean-ssh-private-key` | the matching private key, for Ansible and the operator verbs |
| `digitalocean-ssh-sources` | CIDRs allowed to reach port 22 |
| `digitalocean-client-sources` | CIDRs allowed to reach the endpoint ports |
| `digitalocean-vpc-mode` | must be `default` |

Neither source list may contain `0.0.0.0/0`. There is no VPC key: any of
`digitalocean-vpc-id`, `-uuid`, `-cidr`, `-name` present in the file is an
error, because accepting one would let a deployment be edited onto another's
private network while passing every other check.

## What is deliberately not authenticated

The Patroni REST API and etcd run without passwords or TLS. Both would have
needed a credential this deployment does not have, and inventing one was not an
option. They are reachable only from inside the VPC, enforced by the
DigitalOcean firewall, and the golden suite fails if any of them starts binding
a public address.

Consequence, stated plainly: anything with a foothold inside the VPC can call
`POST /switchover` on Patroni. If a third credential becomes available,
`restapi.authentication` and etcd RBAC are the first two things to spend it on.

## Recovery

### A standby is lost

Nothing to do. Patroni notices, and re-clones the member with `pg_basebackup`
when it returns. `./green status` shows it rejoin. If it was the synchronous
standby, Patroni promotes the other to synchronous immediately, so commits
never wait on a machine that is gone.

### The primary is lost

Nothing to do. The leader lock expires after `patroni-ttl` seconds, the
standbys elect, and the most advanced one promotes. Within one HAProxy
health-check interval after that, every node's HAProxy is forwarding
`haproxy-primary-port` to the new leader, so `cluster-host` serves the new
primary with no DNS change and no operator action.

Verify:

```sh
./green status --node 2
psql -h <cluster-host> -p 5432 -c 'SELECT pg_is_in_recovery()'    # f
```

The old primary rejoins as a standby when it comes back, using `pg_rewind` if
it diverged.

### A planned handover

```sh
./green switchover                                  # Patroni picks a candidate
./green switchover -- --candidate <node-name>       # or name one
```

A switchover is graceful: the primary is checkpointed and demoted, so nothing
is lost. Use it before rebooting the leader.

### Restore to a point in time

The repository holds `backup-retention-full` full backups and every WAL segment
since the oldest of them. To recover the cluster to a chosen moment:

1. Stop Patroni on **every** node, so nothing races the restore:
   `for n in 1 2 3; do ssh <profile>-$n systemctl stop patroni; done`
2. On the node that will become the new primary, clear the data directory and
   restore:
   ```sh
   sudo -u postgres pgbackrest --stanza=main --delta \
     --type=time --target='2026-08-16 09:00:00+00' --target-action=promote restore
   ```
   Omit `--type`/`--target` to recover to the end of the archived WAL.
3. Start PostgreSQL directly once (not Patroni) and let recovery finish, then
   stop it again.
4. Remove the Patroni cluster state so the restored node bootstraps as the new
   leader: `patronictl -c /etc/patroni/patroni.yml remove <cluster-name>`.
5. Start Patroni on that node, confirm it is the leader, then start Patroni on
   the other two — they re-clone from it.

### Rebuild from nothing

The R2 repository is the whole cluster. Provision fresh infrastructure with
`./green create`, then follow the restore procedure above on the node that
bootstraps. `backup-r2-prefix` and `backup-stanza` are what locate the
repository; keep them stable across a rebuild or the new cluster will not find
the old backups.

### Confirming the backups are real

```sh
./green verify-restore --node 2
```

That runs exactly what the daily timer runs: restore the latest backup into a
scratch directory, replay every archived WAL segment, start the result, and
assert that its newest heartbeat row is younger than
`restore-check-max-lag-seconds`. The second assertion is the one that matters —
a check that only replayed the backup would pass with WAL archiving completely
broken.

Its last successful result is recorded on each standby at
`/var/lib/postgresql/.postgres-ha-restore-check`.
