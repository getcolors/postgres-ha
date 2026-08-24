# CLAUDE.md

## What this is

`postgres-ha` is a green-only Package Skill for a three-node PostgreSQL
failover cluster on DigitalOcean: streaming replication with quorum
synchronous commit, Patroni over a colocated three-member etcd, an HAProxy
client endpoint behind a multi-address Cloudflare name, daily pgBackRest full
backups to Cloudflare R2, continuous WAL archiving, and a scheduled verified
restore. The first consumer is `../postgres-ha-digitalocean`.

Read `plans/0001-postgres-ha-v1.md` before changing the topology: it records
what was rejected and why, and most obvious "improvements" are in there. Code
and tests are authoritative.

## Commands

```sh
bb test
bb golden
bb golden:accept        # only after reading the diff
./scripts/launcher.sh
./green build
./green create --dry-run
./green create          # requires explicit authorization
./green delete          # guarded and destructive
```

Operator verbs dispatch over SSH through the aliases the local stage manages:
`./green status`, `switchover`, `failover`, `backup`, `verify-restore`, `psql`,
each accepting `--node N` to pick a live node when the cluster is degraded.

## Invariants

- `colors.yml` is flat, non-secret desired state and the only file a user edits.
- Credentials are `COLORS_PAR_*` only. `COLORS_PAR_PROFILE` is always refused:
  the profile keys both the remote state and the backup repository path.
- `.colors/` is generated. Never read it as source, edit it, or commit it.
- `compute-prevent-destroy: true` stays in committed desired state; lift it for
  one authorized delete with `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false`.
- Build and dry-run are credential-free, which is what makes them the safe way
  to review a `colors.yml` edit.
- Validation refuses every VPC identifier: the regional default VPC is
  discovered by an OpenTofu data source.

## Things that look like details and are not

- **The resource directory is `src/resources/io/github/getcolors/postgres-ha/`,
  with a hyphen.** `green.scaffold` maps a template keyword's namespace dots to
  slashes and does not munge hyphens the way Clojure does for source files. The
  source tree under `src/clj/.../postgres_ha/` keeps the underscore because
  Clojure requires it. The two disagree on purpose.
- **`--archive-mode=off` in `postgres-ha-restore-check`.** A verification copy
  that promoted with archiving enabled would push WAL into the shared
  repository on a timeline the live cluster uses. `bb golden` fails if it goes.
- **Patroni is reloaded, never restarted, by the converge.** A restart drops the
  leader lock, so a configuration change would become a failover.
- **`postgres-port` may equal `haproxy-primary-port`.** PostgreSQL binds the
  private VPC address and HAProxy the public address plus loopback, so 5432 is
  free on both. Validation encodes that one exception and refuses every other
  port collision.
- **The heartbeat is not decoration.** It is what lets the verified restore
  assert that WAL written *after* the last backup was archived and replayed,
  using only peer authentication and therefore no third credential.

## Coupling

The package pins Green in `deps.edn` and nothing else — it owns its provider
registry, its OpenTofu templates and its stage names. Develop across the
boundary with `GREEN_LIB_ROOT` and `POSTGRES_HA_LIB_ROOT`; a change spanning
both repositories is two commits, Green pushed first. Final launcher pins are
stamped only by `bb pin` after a clean pushed commit. Never invent or hand-edit
a SHA.

A deployment's root `./green` is a **copy** of
`skills/package-postgres-ha-green/green`, not a symlink. Inside this repository
the root `./green` *is* the symlink, which is what `scripts/launcher.sh`
asserts.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly asked.
