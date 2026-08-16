# 0001 — postgres-ha v1

The design decisions, and what was rejected. Code and tests are authoritative;
this exists so that a later reader can tell a considered choice from an
accident.

## The problem, and what was fixed for us

A PostgreSQL cluster that survives losing one machine, keeps a client endpoint
pointing at whatever is currently writable, takes daily snapshots to object
storage, retains point-in-time recovery material continuously, and proves on a
schedule that the result is restorable.

Fixed before any decision was taken:

- three droplets, `s-2vcpu-4gb`, `ubuntu-24-04-x64`, region `ams3`;
- the VPC is discovered at runtime, never configured;
- the client endpoint is one DNS name in one Cloudflare zone;
- backups go to one pre-existing Cloudflare R2 bucket;
- **two** database credentials exist: an admin password and a replication
  password. Nothing may require a third.

That last constraint did more to shape this design than any of the others, and
each place it bit is called out below.

## 1. Replication topology — one primary, two hot standbys, quorum commit

Physical streaming replication with replication slots. `synchronous_mode: true`
and `synchronous_node_count: 1` in Patroni, which becomes
`synchronous_standby_names = ANY 1 (...)`.

Three machines is exactly the size at which quorum-of-one is the right answer.
Every commit is acknowledged by the primary and at least one standby before the
client is told it succeeded, so a failover loses no acknowledged transaction.
Losing any one machine leaves two, which is still enough to satisfy the quorum
and to hold an etcd majority.

`synchronous_mode_strict` is deliberately **false**. Strict mode makes a cluster
that has lost both standbys refuse writes outright. Losing two of three is
already outside this topology's stated tolerance, and in that state a database
that keeps serving with degraded durability — and says so plainly in
`patronictl list` — is more useful than one that stalls.

**Rejected: logical replication.** It does not replicate DDL, sequences behave
differently, and a failover target built from it is not a byte-identical copy —
which makes `pg_rewind` unavailable and makes a physical backup of a standby
meaningless. This is a failover cluster, not a fan-out.

**Rejected: asynchronous replication.** Cheaper and lower latency, and it loses
committed transactions on failover. The entire point of the exercise is that
the failover is safe.

## 2. Failover orchestrator — Patroni

Patroni owns `postgresql.conf`, `pg_hba.conf`, the replication slots, the
leader lock and the promotion decision in one process. That single ownership is
the property that matters: the alternatives all split it, and every split is a
way for two components to disagree about who is primary.

**Rejected: `repmgr`.** Its automatic failover daemon does not hold a lock in a
consensus store; it decides from each node's own view. With three nodes and a
network partition, that is how two primaries happen.

**Rejected: `pg_auto_failover`.** Its monitor is a separate PostgreSQL instance
and is itself a single point of failure. Making it highly available needs a
fourth machine, which the budget does not have.

**Rejected: hand-rolled promotion scripts.** The failure modes of a homegrown
election are discovered in production, and never all at once.

## 3. Quorum store — three-member etcd, colocated

Patroni needs a distributed configuration store to hold the leader lock.
Colocating a three-member etcd on the same three droplets is explicitly
permitted and is the only option inside the machine budget.

Patroni 4 removed the `raft` DCS, so "Patroni with no separate store" does not
exist any more. Kubernetes as a DCS would require a Kubernetes cluster.

etcd binds only the private VPC addresses. It runs without authentication or
TLS, and that is a consequence of the credential constraint, not an oversight:
etcd RBAC or client certificates would each have needed a credential this
deployment does not have. The compensating control is the DigitalOcean firewall,
which admits the client and peer ports only from inside the VPC — so widening
that firewall rule is a security change, and the OpenTofu template says so.

## 4. Client endpoint — HAProxy on every node, three A records

This is the decision with the most plausible alternatives, so it gets the most
space.

`pg-ha.<zone>` resolves to **all three** node addresses, DNS-only, TTL 60. Each
node runs an HAProxy in TCP mode that health-checks Patroni's REST API:
`/primary` returns 200 on exactly the node holding the leader lock, `/replica`
only on a streaming standby. Port 5432 forwards to the primary, 5433 to the
standbys round-robin.

Two properties make this work:

1. **Nothing changes during a failover.** The DNS records are static, no cloud
   API is called, and no node has to hold a credential for one. Within one
   health-check interval every HAProxy has independently noticed that
   `/primary` moved. A mechanism that needs an API call at the moment the
   cluster is degraded is a mechanism that needs the API to be reachable
   exactly when it is least likely to be.
2. **A dead node is skipped by the client, not by DNS.** libpq resolves the host
   name and tries each returned address in turn until one connects. So
   `psql -h pg-ha.<zone>` succeeds while one of the three is down, with no
   client-side configuration and no DNS propagation delay. This is the property
   that makes three A records safe rather than a one-in-three failure rate.

**Rejected: a DigitalOcean Reserved IP, reassigned by a Patroni
`on_role_change` callback.** It gives a single stable address, which is
tidier — and it costs a write-scoped DigitalOcean API token on every database
node, and it makes the endpoint depend on a control-plane API call during a
failover. Both are worse than three A records.

**Rejected: keepalived / VRRP.** DigitalOcean's network is layer 3; gratuitous
ARP for a shared address does not work.

**Rejected: a DigitalOcean Load Balancer.** It is a fourth tier of managed
infrastructure, it costs more than a droplet, and its TCP health check cannot
express "ask Patroni which of you is the leader" without a helper endpoint —
which is the HAProxy check, one layer further away.

**Rejected: `target_session_attrs=read-write` with a multi-host connection
string.** It genuinely works and needs no proxy at all. It was rejected because
it moves the failover mechanism into every client's connection string: the
endpoint is then a convention that each application has to implement correctly,
rather than a name that behaves. The HAProxy layer means a client that knows
nothing about Patroni still reaches the primary — and `target_session_attrs`
remains available on top of it for clients that want belt and braces.

The records must not be proxied. Cloudflare's proxy speaks HTTP; desired-state
validation refuses `cloudflare-proxied: true` rather than letting it fail as a
connection reset months later.

### What this costs, measured

A failover was exercised against the live cluster by powering the leader's
droplet off through the DigitalOcean API. The promotion and the endpoint both
behaved as designed — but the first client probe afterwards hung, and that
exposed the one real cost of this choice.

A machine that is **powered off** does not refuse connections; it black-holes
the SYN. libpq's default `connect_timeout` is unset, so it waits out the OS TCP
retry — roughly two minutes — before moving to the next address in the record
set. Measured over ten probes with one dead node still resolving, and
`connect_timeout=5`:

| resolved order | probes | latency |
|---|---|---|
| a live address first | 6 | ~80 ms |
| the dead address first | 4 | ~5090 ms |
| **failed** | **0** | — |

glibc rotates the addresses it returns, so about one connection in three pays
the bound while a node is down, and none fail.

So this endpoint requires exactly one client parameter — `connect_timeout` —
which is now `client-connect-timeout-seconds` in desired state, documented
everywhere the endpoint is documented, and asserted by an acceptance check that
probes `3 × nodes` times and requires every probe to reach a read-write primary
inside `connect_timeout × (nodes − 1) + 10s`.

That is a smaller ask than the rejected `target_session_attrs` alternative, and
worth being precise about why: `connect_timeout` is a timeout. It needs no
knowledge of Patroni, of roles, or of which node is primary, and every driver
has it. `target_session_attrs=read-write` asks the client to implement the
*selection*, which is the mechanism itself.

It is also worth being clear how narrow the case is. The pause happens only on
total node loss. A crashed PostgreSQL, a stopped Patroni, an OOM kill or a
service restart all leave the node's HAProxy answering and forwarding to the
new leader, and the endpoint does not pause at all.

## 5. Backup tool — pgBackRest

`repo1-type=s3` against R2's S3-compatible endpoint with `uri-style=path`. A
full backup daily, `repo1-retention-full=4`, zstd compression.

pgBackRest is chosen over the alternatives for the properties that matter to
the *restore* rather than to the backup:

- it validates its own repository (`pgbackrest check`, `info` with a status
  field), so "is the backup usable" is a question with an answer;
- `archive-push` and `archive-get` are the same tool as `backup` and `restore`,
  so the PITR path is not a second mechanism that can rot separately;
- restoring to an alternate `pg1-path` with `--archive-mode=off` is a
  first-class operation, which is what makes the scheduled verification safe.

**Rejected: WAL-G.** Comparable and widely used, with a smaller operational
surface. pgBackRest won on `check` and on the alternate-path restore being
supported rather than improvised.

**Rejected: `pg_dump` on a timer.** A logical dump is not a point-in-time
recovery mechanism; the best it can offer is "the state at 01:00".

**Rejected: DigitalOcean droplet snapshots.** They snapshot a disk, not a
consistent database, and they do not leave the provider.

## 6. PITR — continuous WAL archiving through Patroni's DCS

`archive_mode = on` and
`archive_command = pgbackrest --stanza=main archive-push %p`, set in Patroni's
**bootstrap DCS** section rather than in a file on each node. That placement is
the decision: DCS settings are cluster-wide state, so a standby promoted thirty
seconds ago is already archiving with the same command, without anything having
to reconfigure it.

`archive_timeout = 60s` bounds the recovery window on an idle cluster, which
otherwise archives nothing and lets the most recent restorable point drift
backwards. `restore_command` is set for the same reason in reverse: a standby
that falls behind the primary's retained WAL can fetch the gap from the
repository instead of needing a full re-clone.

## 7. Verified restore — end of WAL, on a standby, against a heartbeat

A daily timer on every node; it does nothing unless Patroni's `/replica`
answers 200, so it runs on the standbys and never on the leader.

It restores the latest backup into a scratch directory, replays **every**
archived WAL segment, starts the result on a spare port with a scratch socket
directory, waits for recovery to end, and then asserts two things:

- the restored copy contains sentinel rows at all — the backup restored;
- its newest heartbeat is younger than `restore-check-max-lag-seconds` — the
  WAL written *after* that backup was archived and replayed.

The second assertion is the one that earns the word "verified". A check that
recovered only to the end of the backup would pass with WAL archiving
completely broken.

`--archive-mode=off` is not optional. A restored copy that promoted with
archiving still enabled would push its own WAL into the shared repository on a
timeline the live cluster also uses, and quietly poison every future restore.
`bb golden` fails if that flag disappears from the script.

### The heartbeat, and why it exists

The obvious way to prove WAL continuity is to write a row and then look for it
in a restored copy. But the check runs on a *standby*, which is read-only, and
reaching the primary from there is a TCP connection that needs a password —
which is a credential on disk that this deployment cannot justify.

So the write moved to where it is free. A one-line script runs every minute on
every node, does nothing unless it holds the leader lock, and on the leader
inserts one row over the Unix socket with peer authentication — no password, no
credential file, nothing. The standby then compares against that row using peer
authentication on its own local replica.

The constraint that there are only two database credentials produced a better
design than the one that would have used a third.

## 8. What is deliberately not authenticated

Patroni's REST API and etcd's client and peer ports have no password. Both
would have required a credential the brief does not supply, and inventing one
was not an option.

The compensating control is that neither is reachable from outside the VPC:
PostgreSQL binds the private address, Patroni's REST API binds the private
address, etcd binds the private address and loopback, and the DigitalOcean
firewall admits everything else only from `data.digitalocean_vpc.default.ip_range`.
`bb golden` fails if any of those binds becomes `0.0.0.0`.

This is a real trade-off and it is worth stating plainly: anything that gains
a foothold inside the VPC can call `POST /switchover` on Patroni. If a third
credential ever becomes available, `restapi.authentication` and etcd RBAC are
the first two things to spend it on.

## 9. Stage layout

```
start ─ infrastructure ─ dns ─ ansible-local ─ cluster ─ acceptance
```

Strictly sequential, with no fan-out. The stages are genuinely dependent: DNS
needs the addresses compute produced, the cluster play needs the inventory
those addresses build, and acceptance needs both a converged cluster and a
resolvable name. Parallelism would buy back only the seconds DigitalOcean
already spends creating three droplets inside one `apply`.

Delete reverses the same edges, but loads node addresses from remote state
first: the local SSH configuration it has to withdraw is keyed by them, and by
the time it runs the droplets may already be gone.

One `digitalocean_droplet` resource with a `count`, not three addressed
resources. The nodes are interchangeable by construction — any of them can hold
the leader lock — and a per-node resource address is an invitation to the
per-node configuration drift this design specifically must not have.
