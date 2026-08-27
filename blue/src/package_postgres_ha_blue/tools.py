"""The five stages: DigitalOcean infrastructure, Cloudflare DNS, local SSH
configuration, the remote cluster convergence, and acceptance — the port of
io.github.getcolors.postgres-ha.tools.

Every stage renders into `.colors/<profile>/<stage>/` and, for the OpenTofu
ones, keys its remote state at `<profile>/<stage>.tfstate`. Those two names
are the deployment's identity; changing either orphans live infrastructure,
so they are constants here and asserted by the golden suite."""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.providers import tool_env
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed

from . import utils, validate

infrastructure_tool = "postgres-ha-infrastructure"
dns_tool = "postgres-ha-dns"
ansible_local_tool = "postgres-ha-ansible-local"
cluster_tool = "postgres-ha-cluster"
acceptance_tool = "postgres-ha-acceptance"
tofu_tools = [infrastructure_tool, dns_tool]

ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="postgres-ha")


def template(path: str, file: str) -> dict:
    name = f"tools/{path.replace('.', '/')}/{file}"
    source = ROOT / name
    if not source.is_file():
        raise StepError(f"template not found: {name}")
    return {"name": name, "content": source.read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    return tool_env(validate.providers, opts, [*slots, "provider-backend"])


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


def cidrs(opts: dict, key: str) -> list[str]:
    value = opts.get(key)
    items = value if isinstance(value, list) else re.split(
        r"[,\s]+", "" if value is None else str(value))
    return [text for text in (str(item).strip() for item in items) if text]


# ---------------------------------------------------------------------------
# Placeholder topology
#
# `build` renders the whole tree without contacting a provider, so it needs
# addresses that are obviously not real. RFC 5737 TEST-NET-1 and RFC 1918
# values make a golden file that leaks into a real run fail loudly rather
# than point at somebody's host, and they keep the goldens a pure function of
# colors.yml.

fallback_outputs = {
    "vpc_id": "00000000-0000-0000-0000-000000000000",
    "vpc_ip_range": "10.114.0.0/20",
    "node_public_ips": ["192.0.2.11", "192.0.2.12", "192.0.2.13"],
    "node_private_ips": ["10.114.0.11", "10.114.0.12", "10.114.0.13"],
}


def _output_map(result: dict) -> dict:
    return result.get("postgres-ha/outputs") or {}


def nodes(opts: dict) -> list[dict]:
    """The rendered topology: one map per ordinal, joined with whatever
    addresses the infrastructure stage produced (or the placeholders, before
    it has run)."""
    fallback_public = fallback_outputs["node_public_ips"]
    fallback_private = fallback_outputs["node_private_ips"]
    public = list(opts.get("node_public_ips") or fallback_public)
    private = list(opts.get("node_private_ips") or fallback_private)

    def at(values: list, fallback: list, i: int):
        return values[i] if i < len(values) else fallback[i]

    return [{
        "ordinal": n,
        "name": utils.node_name(opts, n),
        "alias": utils.ssh_alias(opts, n),
        "public-ip": at(public, fallback_public, n - 1),
        "private-ip": at(private, fallback_private, n - 1),
    } for n in utils.ordinals()]


# ---------------------------------------------------------------------------
# Stage 1 — infrastructure


def infrastructure_data(opts: dict) -> dict:
    return {
        **opts,
        "node-names-hcl": tofu.hcl_list([utils.node_name(opts, n) for n in utils.ordinals()]),
        "ssh-keys-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-ssh-keys")),
        "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-ssh-sources")),
        "client-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-client-sources")),
    }


def infrastructure_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, infrastructure_tool)
    return [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf",
                 infrastructure_data(opts))]


async def infrastructure_step(opts: dict) -> dict:
    result = await tofu.tofu_with_spec(
        opts, infrastructure_specs(opts),
        dir=tool_dir(opts, infrastructure_tool),
        env=credential_env(opts, "provider-compute"),
        output_key="postgres-ha/outputs")
    if failed(result):
        return result
    if opts.get("blue/event") == "delete":
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_outputs}
    return {**result, **fallback_outputs, **_output_map(result)}


async def load_infrastructure_step(opts: dict) -> dict:
    """Read node addresses out of remote state without planning or mutating
    cloud resources.

    Delete needs the addresses before it destroys anything — the local SSH
    configuration is keyed by them — and a `plan` at that moment would be a
    second chance to change infrastructure on the way to removing it."""
    dir = tool_dir(opts, infrastructure_tool)
    rendered = {
        **scaffold({**opts, "blue/event": "build"}, infrastructure_specs(opts)),
        "blue/event": opts.get("blue/event"),
    }
    credentials = credential_env(opts, "provider-compute")
    init = await runtime.exec(
        ["tofu", f"-chdir={dir}", "init", "-input=false", "-no-color"],
        env=credentials)
    if init.exit != 0:
        return process_result(rendered, "infrastructure state initialization", init)
    try:
        outputs = await tofu.outputs(dir, credentials)
        return {**rendered, **fallback_outputs, **outputs,
                "postgres-ha/infrastructure-present?": "node_public_ips" in outputs}
    except Exception as t:
        return {**rendered, "blue/exit": 1,
                "blue/err": "infrastructure state output failed: "
                            f"{str(t) or type(t).__name__}"}


# ---------------------------------------------------------------------------
# Stage 2 — DNS
#
# One A record per node, all carrying `cluster-host`. libpq resolves the name
# and tries every address it gets back, so a node that is down is skipped by
# the client itself: the endpoint survives a failover without any DNS write,
# and nothing has to hold a cloud API credential at the moment the cluster is
# degraded. See plans/0001 for the alternative that was rejected.


def dns_data(opts: dict) -> dict:
    return {**opts, "nodes": nodes(opts)}


def dns_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, dns_tool)
    return [spec(template("dns", "main.tf"), f"{dir}/main.tf", dns_data(opts))]


async def dns_step(opts: dict) -> dict:
    return await tofu.tofu_with_spec(
        opts, dns_specs(opts),
        dir=tool_dir(opts, dns_tool),
        env=credential_env(opts, "provider-dns"),
        output_key="postgres-ha/dns-outputs")


# ---------------------------------------------------------------------------
# Shared render data


def data_fn(opts: dict) -> dict:
    ns = nodes(opts)
    etcd_version = str(opts.get("etcd-version") or "")
    return {
        **opts,
        "nodes": ns,
        "first-node": ns[0],
        "vpc-cidr": opts.get("vpc_ip_range") or fallback_outputs["vpc_ip_range"],
        "ssh-private-key": str(opts.get("digitalocean-ssh-private-key") or ""),
        "backup-r2-s3-endpoint": utils.endpoint_host(opts.get("backup-r2-endpoint")),
        "backup-repo-path": utils.repo_path(opts.get("backup-r2-prefix")),
        "etcd-tarball": f"etcd-{etcd_version}-linux-amd64.tar.gz",
        "etcd-url": "https://github.com/etcd-io/etcd/releases/download/"
                    f"{etcd_version}/etcd-{etcd_version}-linux-amd64.tar.gz",
        "postgres-data-dir": f"/var/lib/postgresql/{opts.get('postgres-version')}/main",
        "postgres-bin-dir": f"/usr/lib/postgresql/{opts.get('postgres-version')}/bin",
        "admin-password-lookup": utils.par_lookup("postgres-admin-password"),
        "replication-password-lookup": utils.par_lookup("postgres-replication-password"),
        "backup-key-lookup": utils.par_lookup("backup-r2-access-key-id"),
        "backup-secret-lookup": utils.par_lookup("backup-r2-secret-access-key"),
    }


# ---------------------------------------------------------------------------
# Stage 3 — local SSH configuration


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = data_fn(opts)
    return [
        spec(template("ansible-local", "ansible.cfg"), f"{dir}/ansible.cfg", data),
        spec(template("ansible-local", "inventory.ini"), f"{dir}/inventory.ini", data),
        spec(template("ansible-local", "main.yml"), f"{dir}/main.yml", data),
    ]


async def ansible_local_step(opts: dict) -> dict:
    data = data_fn(opts)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=tool_dir(opts, ansible_local_tool),
        inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={
            "block_state": "absent" if delete else "present",
            "nodes": [{"alias": node["alias"], "public-ip": node["public-ip"],
                       "ordinal": node["ordinal"]}
                      for node in data["nodes"]],
            "ssh_private_key": data["ssh-private-key"],
        })


# ---------------------------------------------------------------------------
# Stage 4 — the cluster itself


def _java_double(x: float) -> str:
    """Java's Double.toString, which is what Cheshire renders floats through
    and therefore what green's committed inventory bytes would carry.
    Integral numbers print as longs. Python's own repr disagrees exactly
    where scientific notation starts (0.0001 -> "1.0E-4"), and the goldens
    carry the Java form."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    negative = math.copysign(1.0, x) < 0
    magnitude = abs(x)
    if magnitude == 0.0:
        return "-0.0" if negative else "0.0"
    _sign, digits, exponent = Decimal(repr(magnitude)).as_tuple()
    digit_str = "".join(map(str, digits)).rstrip("0") or "0"
    dec_exp = exponent + len(digits) - 1
    if -3 <= dec_exp < 7:
        if dec_exp >= 0:
            whole = digit_str[:dec_exp + 1].ljust(dec_exp + 1, "0")
            frac = digit_str[dec_exp + 1:] or "0"
        else:
            whole = "0"
            frac = "0" * (-dec_exp - 1) + digit_str
        rendered = f"{whole}.{frac}"
    else:
        mantissa = digit_str[0] + "." + (digit_str[1:] or "0")
        rendered = f"{mantissa}E{dec_exp}"
    return ("-" if negative else "") + rendered


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    if isinstance(value, float) and not isinstance(value, bool):
        return _java_double(value)
    return json.dumps(value)


def inventory(opts: dict) -> str:
    """A JSON inventory rather than INI: the per-host facts the templates
    need are structured, and `private_ip` in particular is what every
    generated etcd, Patroni and HAProxy stanza is built from."""
    data = data_fn(opts)
    hosts = {node["name"]: {
        "ansible_host": node["public-ip"],
        "ansible_user": "root",
        "private_ip": node["private-ip"],
        "node_ordinal": node["ordinal"],
    } for node in sorted(data["nodes"], key=lambda node: node["name"])}
    return _pretty(
        {"all": {"children": {"postgres": {
            "hosts": hosts,
            "vars": {"ansible_ssh_private_key_file": data["ssh-private-key"]},
        }}}})


# The scripts and units that carry the backup, PITR-continuity and
# verified-restore schedule. All three pairs are installed on all three
# nodes; each asks Patroni what it is before doing anything, so the schedule
# follows the leader lock instead of a node name.
scheduled_work_templates = [
    "postgres-ha-heartbeat", "postgres-ha-heartbeat.service",
    "postgres-ha-heartbeat.timer",
    "postgres-ha-backup", "postgres-ha-backup.service", "postgres-ha-backup.timer",
    "postgres-ha-restore-check", "postgres-ha-restore-check.service",
    "postgres-ha-restore-check.timer",
]


def cluster_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, cluster_tool)
    data = data_fn(opts)
    return [
        spec(template("ansible-remote", "ansible.cfg"), f"{dir}/ansible.cfg", data),
        spec(template("ansible-remote", "main.yml"), f"{dir}/main.yml", data),
        spec(template("ansible-remote", "cleanup.yml"), f"{dir}/cleanup.yml", data),
        spec(template("ansible-remote", "etcd.conf.yml.j2"),
             f"{dir}/templates/etcd.conf.yml.j2", data),
        spec(template("ansible-remote", "etcd.service.j2"),
             f"{dir}/templates/etcd.service.j2", data),
        spec(template("ansible-remote", "patroni.yml.j2"),
             f"{dir}/templates/patroni.yml.j2", data),
        spec(template("ansible-remote", "patroni.service.j2"),
             f"{dir}/templates/patroni.service.j2", data),
        spec(template("ansible-remote", "haproxy.cfg.j2"),
             f"{dir}/templates/haproxy.cfg.j2", data),
        spec(template("ansible-remote", "pgbackrest.conf.j2"),
             f"{dir}/templates/pgbackrest.conf.j2", data),
        raw_spec(f"{dir}/inventory.json", inventory(opts)),
        # The nine scheduled-work files are listed once, here, because the
        # playbook loops over the same names when it installs them. Two lists
        # that had to be kept in step by hand is how a unit ends up rendered
        # but never enabled.
        *(spec(template("ansible-remote", f"{unit}.j2"),
               f"{dir}/templates/{unit}.j2", data)
          for unit in scheduled_work_templates),
    ]


async def cluster_step(opts: dict) -> dict:
    if (opts.get("blue/event") == "delete"
            and opts.get("postgres-ha/infrastructure-present?") is False):
        return scaffold(opts, cluster_specs(opts))
    return await ansible_with_spec(
        opts, cluster_specs(opts),
        dir=tool_dir(opts, cluster_tool),
        inventory="inventory.json",
        playbooks={"create": "main.yml", "delete": "cleanup.yml"},
        host_key_checking=False,
        recap_key="postgres-ha/cluster-recap")


# ---------------------------------------------------------------------------
# Stage 5 — acceptance


def acceptance_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, acceptance_tool)
    return [spec(template("acceptance", "acceptance.sh"),
                 f"{dir}/acceptance.sh", data_fn(opts))]


def process_result(opts: dict, label: str, result) -> dict:
    if result.exit == 0:
        return {**opts, "blue/exit": 0}
    return {**opts, "blue/exit": max(1, result.exit),
            "blue/err": f"{label} failed: {result.err or result.out or '(no output)'}"}


def acceptance_env(opts: dict) -> dict[str, str]:
    """The credential the acceptance script authenticates with, taken from
    opts rather than read again from the ambient environment so a
    `COLORS_PAR_*` overlay and a desired-state value cannot disagree. The
    extra environment is added to the inherited one, so nothing else has to
    be repeated here."""
    password = opts.get("postgres-admin-password")
    return {"PGPASSWORD": "" if password is None else str(password)}


async def acceptance_step(opts: dict) -> dict:
    rendered = scaffold(opts, acceptance_specs(opts))
    if opts.get("blue/event") != "create":
        return rendered
    result = await runtime.exec(
        ["bash", f"{tool_dir(opts, acceptance_tool)}/acceptance.sh"],
        env=acceptance_env(opts), timeout_ms=20 * 60 * 1000)
    # The script's own transcript is the evidence a health check produced.
    # Printing it on success as well as failure is the difference between
    # "acceptance passed" and knowing which eight things it asserted.
    if result.out:
        print(result.out)
    return process_result(rendered, "acceptance", result)


def generated_cleanup_step(opts: dict) -> dict:
    return scaffold(scaffold(opts, ansible_local_specs(opts)), acceptance_specs(opts))
