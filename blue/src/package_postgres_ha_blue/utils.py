"""Launcher contract and deterministic topology helpers, the port of
io.github.getcolors.postgres-ha.utils.

Everything here is a pure function of desired state. The topology is derived
rather than configured: three nodes with stable ordinals, stable Ansible
aliases, and stable droplet names, so an OpenTofu address and an inventory
host name never move because a list was reordered."""

from __future__ import annotations

import re

# Minimum library contract a copied launcher requires. Bumped when the
# launcher and library must move together.
CONTRACT = 1

# The only supported cluster size. Three is what makes a quorum store
# colocatable and a quorum-commit standby set meaningful; two cannot elect and
# four is outside the authorized machine budget.
NODE_COUNT = 3


def ordinals() -> list[int]:
    """1..NODE_COUNT. The one place the node range is produced."""
    return list(range(1, NODE_COUNT + 1))


def base_name(opts: dict) -> str:
    name = str(opts.get("digitalocean-name") or "")
    return name if name else "postgres-ha"


def node_name(opts: dict, n: int) -> str:
    """The droplet name for ordinal `n`, also the Ansible inventory host name
    and the Patroni member name. One string for all three keeps `patronictl
    list`, `tofu state list` and the inventory mutually greppable."""
    return f"{base_name(opts)}-{n}"


def profile_alias(opts: dict) -> str:
    profile = str(opts.get("profile") or "")
    return profile if profile else "postgres-ha"


def ssh_alias(opts: dict, n: int) -> str:
    """The `~/.ssh/config` Host entry the operator commands use for ordinal `n`."""
    return f"{profile_alias(opts)}-{n}"


def par_lookup(key: str) -> str:
    """The Ansible expression that reads a credential at play time.

    Rendered into generated files instead of the value, so a secret reaches a
    host through the process environment and never through a file on disk
    here."""
    return "{{ lookup('env','COLORS_PAR_%s') }}" % str(key).replace("-", "_").upper()


def endpoint_host(endpoint) -> str:
    """The S3 endpoint host pgBackRest wants: it takes a bare host, not a URL."""
    text = "" if endpoint is None else str(endpoint)
    text = re.sub(r"^https?://", "", text)
    return re.sub(r"/.*$", "", text)


def repo_path(prefix) -> str:
    """pgBackRest's repository path is absolute inside the bucket."""
    p = re.sub(r"^/+", "", "" if prefix is None else str(prefix))
    return "/" if not p.strip() else f"/{p}"
