# CLAUDE.md

## What this is

`postgres-ha` is a tri-colour Package Skill (green, red, blue) for a
three-node PostgreSQL failover cluster on DigitalOcean: streaming replication
with quorum synchronous commit, Patroni over a colocated three-member etcd, an
HAProxy client endpoint behind a multi-address Cloudflare name, daily
pgBackRest full backups to Cloudflare R2, continuous WAL archiving, and a
scheduled verified restore. The first consumer is
`../postgres-ha-digitalocean`.

Read `plans/0001-postgres-ha-v1.md` before changing the topology: it records
what was rejected and why, and most obvious "improvements" are in there. Code
and tests are authoritative.

## Layout and commands

The three implementations live in the tri-colour layout, matching `netbird`
and `clickstack`: canonical Clojure in `green/` (`green/bb.edn`,
`green/deps.edn`, `green/src/`, `green/tasks/`, tests under `green/test/clj`),
TypeScript/Bun in `red/`, and Python/uv in `blue/`. Green is canonical: a
behavioural change lands in all three colours in the same commit and passes
`scripts/parity.sh`, which renders both backend variants through every colour
and diffs the trees — and the colour template trees (`red/resources`, blue's
embedded `resources/`) — byte for byte. The fixture and the goldens are shared
across colours at the repository root — `test/fixtures/` and
`test/resources/golden/` — with `green/test/fixtures` and
`green/test/resources` symlinks pointing at them. Each colour dir holds a
launcher symlink to its skill payload (`green/green`, `red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept   # only after reading the diff
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, two backends, byte for byte
./scripts/launcher.sh          # from the repository root
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create     # requires explicit authorization
cd green && ./green delete     # guarded and destructive
```

The goldens have two axes. `test/fixtures/colors.yml` is the keygen-mode
fixture (no `digitalocean-ssh-keys`: the package owns the keypair) and
`test/fixtures/optout.yml` is the opt-out fixture (an explicit key id: the
package touches no key material and renders byte-for-byte what it rendered
before the SSH Keypair Standard, under its own profile). Each is rendered
under the **r2** state backend it declares and again under **s3**,
produced by overlaying `COLORS_PAR_PROVIDER_BACKEND` on the same file. The
four committed trees live at
`test/resources/golden/{s3,r2}/postgres-ha-{fixture,optout}/`; the backend
pair differs only in each OpenTofu stage's `backend.tf.json`.

Operator verbs dispatch over SSH through the aliases the local stage manages:
`status`, `switchover`, `failover`, `backup`, `verify-restore`, `psql` — the
same verbs in every colour, each accepting `--node N` to pick a live node when
the cluster is degraded.

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
  discovered by an OpenTofu data source. Every machine in that VPC is inside
  the cluster's east-west trust boundary — the VPC-scoped firewall rules take
  its `ip_range` as their source — which the Compute Cluster Standard names as
  a security exception of a discovered network.

## Things that look like details and are not

- **The resource directory is
  `green/src/resources/io/github/getcolors/postgres-ha/`, with a hyphen.**
  `green.scaffold` maps a template keyword's namespace dots to slashes and
  does not munge hyphens the way Clojure does for source files. The source
  tree under `green/src/clj/.../postgres_ha/` keeps the underscore because
  Clojure requires it. The two disagree on purpose. `red/resources` and
  `blue/src/package_postgres_ha_blue/resources` are byte-for-byte copies of
  that tree — the copies are the mechanism, and `scripts/parity.sh` diffs
  them.
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

Every color depends on the pinned colors-compute library for compute, remote
state, provider credentials, SSH keys, topology expansion, and lifecycle
ownership. The package declares three homogeneous peers and application network
requirements. Colors fans out the same library node operation, then joins
complete observed outputs for Ansible and DNS. ONCE remains only for application
DNS helpers and its separate backend credential binding.

Provider templates and registries belong to the library. Supporting another
compatible provider requires a dependency bump, without application source or
provider fixture changes. Build and dry-run use documentation addresses and a
placeholder home without reading local keys. Real operations validate remote
ownership before generating keys or invoking a compute provider. Existing
monolithic compute state requires an explicit migration; it is never silently
adopted. Local SSH config plays remain package-owned and use observed SSH users
and the selected identity path.

Manifests and lockfiles pin published dependencies. Publish package source before
running `bb pin` in `green/`, then publish the stamped launcher copies. Red
launchers resolve compute and SDK transitively through the pinned package;
repeating these Git dependencies breaks cold installation in Bun 1.3.13.


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

### Repeated deletion after compute retirement

A repeated `delete` with validated retired compute ownership resumes only the
local generated-file cleanup. It does not require removed SSH keys or contact
the former hosts, DNS, registry, or other application cloud resources. Failed
ownership inspection still stops deletion. Local cleanup preserves unrelated
files and is safe to repeat.
