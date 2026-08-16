---
name: package-postgres-ha-green
description: Provision and operate a three-node PostgreSQL failover cluster on DigitalOcean with Patroni, etcd, HAProxy, Cloudflare DNS, and pgBackRest point-in-time recovery to Cloudflare R2, using Green.
license: MIT
---

# PostgreSQL failover cluster

Read [references/configuration.md](references/configuration.md) before changing
desired state or running a real lifecycle operation. It documents every key,
the recovery procedure, and the trade-offs that are deliberate.

Three droplets in one region's default VPC — discovered, never configured —
running PostgreSQL with one primary and two hot standbys, quorum synchronous
commit, Patroni over a colocated three-member etcd, an HAProxy client endpoint,
daily pgBackRest full backups to Cloudflare R2, continuous WAL archiving, and a
verified restore that runs on a schedule.

## Safety

- Keep credentials only in a gitignored `.envrc.private` as `COLORS_PAR_*`
  exports. Never place one in `colors.yml`, in generated output, or in
  documentation.
- Never set `COLORS_PAR_PROFILE`. The profile keys both the OpenTofu remote
  state and the backup repository path; overlaying it points this deployment at
  another one's.
- Never edit or commit `.colors/`.
- Keep `compute-prevent-destroy: true`. Lift it with
  `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` for one authorized `delete`.
- Run `build` and `create --dry-run` before any real lifecycle operation. Both
  work with an empty environment.
- The Patroni REST API and etcd have no authentication and are protected by the
  VPC firewall alone. Widening `digitalocean-ssh-sources` or
  `digitalocean-client-sources`, or exposing those ports, is a security change.

## Commands

```sh
./green build              # render the work directory only — contact nothing
./green create --dry-run   # walk the graph, skip every side effect
./green create             # converge
./green delete             # guarded and destructive
```

## Operating the cluster

```sh
./green status             # patronictl list — members, roles, replication lag
./green switchover         # planned handover to a healthy standby
./green failover --node 2  # unplanned promotion, dispatched via a live node
./green backup             # run the full backup now, on the leader
./green verify-restore     # run the verified restore now, on a standby
./green psql               # a session on the current primary, via HAProxy
```

Every verb dispatches over SSH through the `~/.ssh/config` aliases the local
stage manages, so the identity file and host-key policy are defined once.
`--node N` picks which node to dispatch through; use a live one when the
cluster is degraded.

## Connecting

`cluster-host` resolves to all three nodes. Port `haproxy-primary-port` always
reaches the node currently holding the leader lock; `haproxy-replica-port`
reaches a standby. Nothing about the DNS records changes during a failover.

```sh
psql -h <cluster-host> -p 5432 -U <postgres-admin-user> -d <postgres-database>
```

Clients that want a second layer of protection can add
`target_session_attrs=read-write` to the connection string; it is compatible
with, not a replacement for, the HAProxy endpoint.
