"""Credential-free desired-state validation, and the provider registry it
uses — the port of io.github.getcolors.postgres-ha.validate.

The compute registry is package-owned — this package provisions three
droplets, its own firewall and its own DNS record set, so the keys a stage
interpolates are not ONCE's single-server keys — and the operations over it
are ONCE's ``compute_cluster`` module, the one implementation of the Compute
Cluster Standard: selection, the required keys, the source lists, the
provider rules, the network mode and the topology are checked there over
``spec``, never copied here. What stays here is what only this package knows:
the fixed node count, the discovered VPC, the scoped ingress, and every
PostgreSQL, Patroni, etcd, HAProxy and pgBackRest rule.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.

Every check accumulates. A run reports all of a file's problems at once with
exit 2, because fixing desired state one error per invocation is how a person
gives up on a config file."""

from __future__ import annotations

import json
import re

from blue.cli import par_name
from package_once_blue import compute as once_compute
from package_once_blue import compute_cluster as cluster
from package_once_blue import ssh as once_ssh

from . import utils

# provider-compute -> what that choice implies.
#
# `required` are non-secret keys the template interpolates. `secrets` arrive
# only through `COLORS_PAR_*`. `tofu-env` is the subset OpenTofu reads
# natively from the process environment, so a credential never has to be
# rendered into a .tf file sitting in the work directory in plaintext.
# `network` is discovered: the region's default VPC, never one this package
# owns. `digitalocean-ssh-keys` is deliberately absent from `required`: per the
# SSH Keypair Standard its absence selects keygen mode, and its presence is the
# opt-out that passes the operator's key ids through untouched.
compute_providers = {
    "digitalocean": {
        "required": ["digitalocean-name", "digitalocean-region", "digitalocean-size",
                     "digitalocean-image", "digitalocean-ssh-sources",
                     "digitalocean-client-sources", "digitalocean-vpc-mode"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
        "network": {"mode": "discovered"},
    },
}

# The provider a deployment created before this package recorded one in its
# compute output must be running: the only one it ever offered.
default_compute_provider = "digitalocean"

# How this package describes itself to ONCE's `compute_cluster`. One
# homogeneous role of `cluster-nodes` members, whose fallback addresses start
# at offset 11 so that `build` renders the same 192.0.2.11-13 and
# 10.114.0.11-13 it always did. The fallback subnet stands in for the
# discovered VPC's range on a build; on a real run the range is the compute
# state's `vpc_ip_range`.
spec: cluster.ClusterSpec = {
    "registry": compute_providers,
    "default": default_compute_provider,
    "sources": {"non_empty": ["ssh-sources", "client-sources"], "may_be_empty": []},
    "roles": [{"role": None, "count_key": "cluster-nodes", "count": 3, "fallback_offset": 11}],
    "fallback_subnet": "10.114.0.0/20",
}

# Provider slot -> provider name -> what that choice implies. The compute slot
# is the registry above, so the OpenTofu environment and the secrets are read
# from one place whichever slot a stage asks for.
providers = {
    "provider-compute": compute_providers,

    "provider-dns": {
        "cloudflare": {
            "required": ["cloudflare-zone", "cloudflare-proxied", "cloudflare-record-ttl",
                         "cluster-host"],
            "secrets": ["cloudflare-api-token"],
            "tofu-env": {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"},
        },
    },

    "provider-backend": {
        "local": {"required": [], "secrets": [], "tofu-env": {}},
        "s3": {
            "required": ["s3-bucket", "s3-region"],
            "secrets": ["s3-access-key-id", "s3-secret-access-key"],
            "tofu-env": {"s3-access-key-id": "AWS_ACCESS_KEY_ID",
                         "s3-secret-access-key": "AWS_SECRET_ACCESS_KEY"},
        },
        # R2 is S3-compatible and therefore authenticates through the AWS
        # chain. These are the *state* credentials; the backup repository has
        # its own pair so a leaked backup key cannot rewrite infrastructure
        # state.
        "r2": {
            "required": ["r2-bucket", "r2-endpoint"],
            "secrets": ["r2-access-key-id", "r2-secret-access-key"],
            "tofu-env": {"r2-access-key-id": "AWS_ACCESS_KEY_ID",
                         "r2-secret-access-key": "AWS_SECRET_ACCESS_KEY"},
        },
    },
}

slots = ["provider-compute", "provider-dns", "provider-backend"]

# The slots this package selects and checks itself; the compute slot is ONCE's.
own_slots = ["provider-dns", "provider-backend"]

profile_par = par_name("profile")

own_required = [
    "profile", "workdir", "cluster-name", "cluster-host", "cluster-nodes",
    "postgres-version", "postgres-port", "postgres-database",
    "postgres-admin-user", "postgres-replication-user",
    "patroni-package-version", "patroni-rest-port", "patroni-ttl",
    "patroni-loop-wait", "patroni-retry-timeout", "patroni-synchronous-node-count",
    "etcd-version", "etcd-sha256", "etcd-client-port", "etcd-peer-port",
    "haproxy-version", "haproxy-primary-port", "haproxy-replica-port",
    "haproxy-stats-port", "client-connect-timeout-seconds",
    "pgbackrest-package-version", "backup-stanza", "backup-oncalendar",
    "backup-retention-full", "restore-check-oncalendar", "restore-check-port",
    "restore-check-max-age-hours", "restore-check-max-lag-seconds",
    "heartbeat-oncalendar", "heartbeat-retention-days",
    "backup-r2-bucket", "backup-r2-endpoint", "backup-r2-region", "backup-r2-prefix",
]

own_secrets = [
    "postgres-admin-password", "postgres-replication-password",
    "backup-r2-access-key-id", "backup-r2-secret-access-key",
]

# A VPC is discovered, never described. Accepting any of these would let one
# deployment place its nodes on another's network while still passing every
# other check, so their mere presence is an error rather than a warning.
# `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr` are refused by ONCE's
# discovered-network rule with its own message; these are the spellings only
# this package refuses.
forbidden_vpc_keys = [
    "digitalocean-vpc-id", "digitalocean-vpc-name", "digitalocean-vpc",
]


def placeholder(x) -> bool:
    return x is None or (isinstance(x, str) and (not x.strip() or x.upper() == "REPLACE_ME"))


def keygen(opts: dict) -> bool:
    """Whether this deployment owns its machine keypair: `digitalocean-ssh-keys`
    is absent. Delegates to ONCE, the standard's reference implementation, so
    one rule decides it everywhere."""
    return once_ssh.keygen(opts)


def entry(opts: dict, slot: str):
    return providers.get(slot, {}).get(str(opts.get(slot)))


def tofu_env(opts: dict, slot: str) -> dict:
    return (entry(opts, slot) or {}).get("tofu-env", {})


def _slot_keys(opts: dict, selected: list[str], field: str) -> list[str]:
    return [key for slot in selected for key in (entry(opts, slot) or {}).get(field, [])]


def _missing(opts: dict, keys: list[str]) -> list[str]:
    return [key for key in keys if placeholder(opts.get(key))]


def env_errors(env: dict) -> list[str] | None:
    if str(env.get(profile_par) or ""):
        return [f"{profile_par} is set. postgres-ha takes profile from colors.yml only; "
                "an environment overlay could point this deployment at another's "
                "remote state and backup repository."]
    return None


_DNS_RE = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
_IDENTIFIER_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
_STANZA_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_ETCD_VERSION_RE = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")
# A Debian version, not a release version: PGDG revisions its own packaging
# (`4.1.5-1.pgdg24.04+1`), and a pin that named only the upstream release
# would still let two converges install different bytes.
_DEB_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.+~:-]+$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ONCALENDAR_RE = re.compile(r"^[A-Za-z0-9 *,./:-]+$")
_HTTPS_RE = re.compile(r"^https://[A-Za-z0-9.-]+(?::[0-9]+)?/?$")
_PREFIX_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


def _positive_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x > 0


def _pr_str(value) -> str:
    """pr-str, for the unsupported-provider message: green prints the
    offending value through pr-str, which quotes strings and renders nil
    bare."""
    if value is None:
        return "nil"
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


# Listeners that must each own a distinct port on every node.
#
# `postgres-port` is deliberately absent. PostgreSQL binds only the node's
# private VPC address, while HAProxy binds only the public address and
# loopback, so the primary listener is expected to reuse 5432 — a client
# reaching `<cluster-host>:5432` and a replica streaming from
# `<private-ip>:5432` never contend. Every other listener here shares an
# address with at least one of the others, so a repeated number is a node that
# half-starts.
_EXCLUSIVE_PORT_KEYS = [
    "patroni-rest-port", "etcd-client-port", "etcd-peer-port",
    "haproxy-primary-port", "haproxy-replica-port", "haproxy-stats-port",
    "restore-check-port",
]


def _is_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _distinct_port_errors(opts: dict) -> list[str]:
    ports = [(key, opts.get(key)) for key in _EXCLUSIVE_PORT_KEYS if _is_int(opts.get(key))]
    grouped: dict[int, list[str]] = {}
    for key, value in ports:
        grouped.setdefault(value, []).append(key)
    dupes = sorted(((port, keys) for port, keys in grouped.items() if len(keys) > 1))
    pg = opts.get("postgres-port")
    shadowed = ([key for key, value in ports
                 if value == pg and key != "haproxy-primary-port"]
                if _is_int(pg) else [])
    return [
        *(f"port {port} is claimed by {' and '.join(keys)}; "
          "every listener on a node needs its own port"
          for port, keys in dupes),
        *(f":{key} must differ from :postgres-port" for key in sorted(shadowed)),
    ]


def state_errors(opts: dict) -> list[str]:
    """Everything wrong with `opts` that does not depend on a credential.
    Empty means the desired state renders. The missing keys are this
    package's, the selected compute provider's (ONCE's `required_keys`) and
    the other slots'; the package's own rules follow; the Compute Cluster
    Standard's — selection, the source lists, the provider and network rules,
    the topology — are ONCE's over `spec`; and the ingress scope this package
    alone insists on comes last."""
    errors: list[str] = []

    def push(condition, message: str) -> None:
        if condition:
            errors.append(message)

    for key in _missing(opts, [*own_required,
                               *once_compute.required_keys(spec, opts),
                               *_slot_keys(opts, own_slots, "required")]):
        errors.append(f":{key} is required")

    for slot in own_slots:
        if entry(opts, slot) is None:
            errors.append(f"unsupported :{slot} {_pr_str(opts.get(slot))}")

    push(opts.get("provider-dns") != "cloudflare", ":provider-dns must be cloudflare")
    push(not isinstance(opts.get("compute-prevent-destroy"), bool),
         ":compute-prevent-destroy must be true or false")
    push(not isinstance(opts.get("cloudflare-proxied"), bool),
         ":cloudflare-proxied must be true or false")
    push(opts.get("cloudflare-proxied") is True,
         ":cloudflare-proxied must be false; Cloudflare's proxy does not carry the PostgreSQL wire protocol")

    push(not (placeholder(opts.get("profile"))
              or _PROFILE_RE.fullmatch(str(opts.get("profile")))),
         ":profile must be a safe 1-63 character name")

    # Opt-out mode reaches the nodes with the operator's own key, so the path
    # to it is desired state there; keygen mode names the generated key itself
    # and must not be asked for one.
    push(not keygen(opts) and placeholder(opts.get("digitalocean-ssh-private-key")),
         ":digitalocean-ssh-private-key is required when digitalocean-ssh-keys is supplied")

    push(opts.get("cluster-nodes") != utils.NODE_COUNT,
         f":cluster-nodes must be {utils.NODE_COUNT}; the topology colocates a "
         "quorum store on the database nodes and cannot elect with fewer")

    push(str(opts.get("digitalocean-vpc-mode")) != "default",
         ":digitalocean-vpc-mode must be default; the regional default VPC is discovered at runtime")
    for key in forbidden_vpc_keys:
        push(key in opts,
             f":{key} must not be configured; the regional default VPC is discovered at runtime")

    for key in ["cluster-host", "cloudflare-zone"]:
        value = opts.get(key)
        push(not placeholder(value) and not _DNS_RE.fullmatch(str(value)),
             f":{key} must be a DNS name")
    host = str(opts.get("cluster-host"))
    zone = str(opts.get("cloudflare-zone"))
    push(not placeholder(opts.get("cluster-host"))
         and not placeholder(opts.get("cloudflare-zone"))
         and not (host == zone or host.endswith(f".{zone}")),
         ":cluster-host must be inside :cloudflare-zone")

    pg_version = opts.get("postgres-version")
    push(not _positive_int(pg_version),
         ":postgres-version must be a PostgreSQL major version integer such as 17")
    push(_is_int(pg_version) and pg_version < 15,
         ":postgres-version must be 15 or later; the topology relies on quorum synchronous commit and pg_rewind")

    for key in ["patroni-package-version", "pgbackrest-package-version"]:
        value = opts.get(key)
        push(not placeholder(value) and not _DEB_VERSION_RE.fullmatch(str(value)),
             f":{key} must be a full Debian package version such as 4.1.5-1.pgdg24.04+1")
    push(not (placeholder(opts.get("etcd-version"))
              or _ETCD_VERSION_RE.fullmatch(str(opts.get("etcd-version")))),
         ":etcd-version must be an exact vX.Y.Z release tag")
    push(not (placeholder(opts.get("etcd-sha256"))
              or _SHA256_RE.fullmatch(str(opts.get("etcd-sha256")))),
         ":etcd-sha256 must be the lowercase hex SHA-256 of the linux-amd64 release tarball")
    push(not (placeholder(opts.get("haproxy-version"))
              or re.fullmatch(r"^[0-9]+\.[0-9]+$", str(opts.get("haproxy-version")))),
         ":haproxy-version must be a distribution major.minor series such as 2.8")

    for key in ["postgres-database", "postgres-admin-user", "postgres-replication-user"]:
        value = opts.get(key)
        push(not placeholder(value) and not _IDENTIFIER_RE.fullmatch(str(value)),
             f":{key} must be an unquoted lowercase SQL identifier")
    push(not placeholder(opts.get("postgres-admin-user"))
         and str(opts.get("postgres-admin-user")) == str(opts.get("postgres-replication-user")),
         ":postgres-replication-user must differ from :postgres-admin-user")

    push(not (placeholder(opts.get("backup-stanza"))
              or _STANZA_RE.fullmatch(str(opts.get("backup-stanza")))),
         ":backup-stanza must be a short lowercase pgBackRest stanza name")
    push(not (placeholder(opts.get("backup-r2-endpoint"))
              or _HTTPS_RE.fullmatch(str(opts.get("backup-r2-endpoint")))),
         ":backup-r2-endpoint must be an https:// origin")
    push(not (placeholder(opts.get("backup-r2-prefix"))
              or _PREFIX_RE.fullmatch(str(opts.get("backup-r2-prefix")))),
         ":backup-r2-prefix must be a relative object-key prefix")
    push(not placeholder(opts.get("backup-r2-bucket"))
         and not placeholder(opts.get("r2-bucket"))
         and str(opts.get("backup-r2-bucket")) == str(opts.get("r2-bucket")),
         ":backup-r2-bucket must not be the OpenTofu state bucket; backups and state do not share a blast radius")

    for key in ["cluster-nodes", "postgres-port", "patroni-ttl",
                "patroni-loop-wait", "patroni-retry-timeout",
                "patroni-synchronous-node-count", "backup-retention-full",
                "restore-check-max-age-hours", "restore-check-max-lag-seconds",
                "heartbeat-retention-days", "cloudflare-record-ttl",
                "client-connect-timeout-seconds", *_EXCLUSIVE_PORT_KEYS]:
        push(not _positive_int(opts.get(key)), f":{key} must be a positive integer")
    errors.extend(_distinct_port_errors(opts))
    # Cloudflare accepts 1 (automatic) or 60..86400. A short explicit TTL is
    # what lets a replaced node leave the endpoint's address set quickly.
    ttl = opts.get("cloudflare-record-ttl")
    ttl_number = ttl if _is_int(ttl) else 0
    push(not (ttl_number == 1 or 60 <= ttl_number <= 86400),
         ":cloudflare-record-ttl must be 1 (automatic) or between 60 and 86400")

    # The endpoint resolves to every node, so a client may try an address
    # whose machine is powered off. That address does not refuse the
    # connection, it black-holes the SYN, and libpq's default is to wait out
    # the OS TCP retry — about two minutes — before trying the next one. This
    # is the value the documentation and the acceptance probe both use; it is
    # desired state rather than folklore precisely because getting it wrong
    # turns a survivable node loss into an outage for a third of new
    # connections.
    connect = opts.get("client-connect-timeout-seconds")
    connect_number = connect if _is_int(connect) else 0
    push(not (1 <= connect_number <= 30),
         ":client-connect-timeout-seconds must be between 1 and 30; it "
         "bounds how long a client waits on a powered-off node's address "
         "before trying the next one in the endpoint's record set")

    sync_count = opts.get("patroni-synchronous-node-count")
    sync_number = sync_count if _is_int(sync_count) else 0
    push(not (0 < sync_number < utils.NODE_COUNT),
         f":patroni-synchronous-node-count must be between 1 and {utils.NODE_COUNT - 1}; "
         "requiring every standby to acknowledge stalls writes when one node is lost")
    loop_wait = opts.get("patroni-loop-wait")
    patroni_ttl = opts.get("patroni-ttl")
    push(not (_is_int(loop_wait) and _is_int(patroni_ttl) and 2 * loop_wait < patroni_ttl),
         ":patroni-ttl must exceed twice :patroni-loop-wait, or the leader lock can expire between health checks")

    for key in ["backup-oncalendar", "restore-check-oncalendar", "heartbeat-oncalendar"]:
        value = opts.get(key)
        push(not placeholder(value) and not _ONCALENDAR_RE.fullmatch(str(value)),
             f":{key} must be a systemd OnCalendar expression")

    # The verified restore asserts that a heartbeat written after the last
    # backup survived the round trip through the archive. Its tolerance has
    # to leave room for `archive_timeout` plus the restore itself, or the
    # check fails on a healthy cluster and stops meaning anything.
    max_lag = opts.get("restore-check-max-lag-seconds")
    max_lag_number = max_lag if _is_int(max_lag) else 0
    push(not (120 < max_lag_number),
         ":restore-check-max-lag-seconds must exceed 120; below that it "
         "fails on a healthy cluster, because a segment is only archived "
         "once archive_timeout elapses")

    errors.extend(cluster.state_errors(spec, opts))

    # ONCE checks that each source list is non-empty and every entry a CIDR;
    # the world is a CIDR, and refusing it is this package's own rule: the
    # PostgreSQL port is a genuinely public port.
    for key in ["digitalocean-ssh-sources", "digitalocean-client-sources"]:
        push(any(value == "0.0.0.0/0" for value in once_compute.cidrs(opts, key)),
             f":{key} must not contain 0.0.0.0/0; administrative and database ingress stay scoped")

    return errors


def secret_errors(opts: dict, selected: list[str] | None = None) -> list[str]:
    chosen = slots if selected is None else selected
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(_missing(opts, [*own_secrets, *_slot_keys(opts, chosen, "secrets")]))]
