"""The five stages: DigitalOcean infrastructure, Cloudflare DNS, local SSH
configuration, the remote cluster convergence, and acceptance — the port of
io.github.getcolors.postgres-ha.tools.

Every stage renders into `.colors/<profile>/<stage>/` and, for the OpenTofu
ones, keys its remote state at `<profile>/<stage>.tfstate`. Those two names
are the deployment's identity; changing either orphans live infrastructure,
so they are constants here and asserted by the golden suite.

The cluster itself — which machines exist, at which addresses — is the
Compute Cluster Standard's `params`, adopted through ONCE's `compute_cluster`
module and carried under `once/cluster`. This package puts its own facts
inside it: `vpc_id` and `vpc_ip_range` at the top level."""

from __future__ import annotations

import json
import math
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.providers import tool_env
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed
from package_once_blue import compute as once_compute
from package_once_blue import compute_cluster as cluster

from . import ssh, ssh_config, utils, validate

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


def backend_advice(tool: str):
    """The state backend of one OpenTofu stage, written before the stage
    runs. `dir` and `key` are explicit so the state addresses cannot move."""
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile')}/{tool}.tfstate")


def _refuse(opts: dict, errors: list[str]) -> dict:
    return {**opts, "blue/exit": 1, "blue/err": "\n".join(errors)}


# ---------------------------------------------------------------------------
# Placeholder topology
#
# `build` renders the whole tree without contacting a provider, so it needs
# values that are obviously not real. The nodes are ONCE's fallbacks — RFC
# 5737 TEST-NET-1 public addresses and RFC 1918 private ones cut from `spec`'s
# subnet at offset 11 — and the network facts beside them are the stand-ins
# below. A golden file that leaked into a real run fails loudly rather than
# pointing at somebody's host, and the goldens stay a pure function of
# colors.yml.

fallback_outputs = {
    "vpc_id": "00000000-0000-0000-0000-000000000000",
    "vpc_ip_range": "10.114.0.0/20",
}


def _cluster_nodes(opts: dict) -> list[dict]:
    """ONCE's nodes for this deployment: the adopted `params.nodes` on a real
    run, the fallbacks on a build — renamed to what this package has always
    called its nodes, `<name>-<ordinal>`, so the rendered inventory is
    byte-identical to what it was."""
    params = opts.get("once/cluster")
    nodes = cluster.nodes(validate.spec, opts, params)
    if params is not None:
        return list(nodes)
    return [{**node, "name": utils.node_name(opts, node["index"] + 1)} for node in nodes]


def ssh_alias(opts: dict, n: int) -> str:
    """The `~/.ssh/config` Host entry the operator commands use for ordinal
    `n`: ONCE's `<profile>-<index>`, the Compute Cluster Standard's alias for
    the node at 0-based `index`. ONCE's list opens with the bare profile, so
    the 1-based ordinal is also the position of its node's alias."""
    return cluster.aliases(validate.spec, opts)[n]


def nodes(opts: dict) -> list[dict]:
    """The rendered topology: one map per ordinal over the node ONCE reports
    — the adopted cluster on a real run, the placeholders before the
    infrastructure stage has run. Pure: given the same opts it is the same
    list, which is what makes the inventory and the goldens deterministic."""
    members = []
    for node in _cluster_nodes(opts):
        ordinal = node["index"] + 1
        members.append({
            "ordinal": ordinal,
            "name": node.get("name"),
            "alias": ssh_alias(opts, ordinal),
            "public-ip": node.get("ip"),
            "private-ip": node.get("vpc_ip"),
        })
    return members


# ---------------------------------------------------------------------------
# Stage 1 — infrastructure


def infrastructure_data(opts: dict) -> dict:
    """The compute template's data. The machine-key paths are filled here as
    well as in preflight, so the template renders the same bytes whichever
    step scaffolds it; in keygen mode the template references the key
    resource and the literal list is not rendered."""
    opts = ssh.with_machine_key(opts)
    return {
        **opts,
        "node-names-hcl": tofu.hcl_list([utils.node_name(opts, n) for n in utils.ordinals()]),
        "ssh-keys-hcl": ("[]" if validate.keygen(opts)
                         else tofu.hcl_list(once_compute.cidrs(opts, "digitalocean-ssh-keys"))),
        "ssh-sources-hcl": tofu.hcl_list(once_compute.cidrs(opts, "digitalocean-ssh-sources")),
        "client-sources-hcl": tofu.hcl_list(once_compute.cidrs(opts, "digitalocean-client-sources")),
    }


def infrastructure_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, infrastructure_tool)
    return [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf",
                 infrastructure_data(opts))]


def output_params(result: dict) -> dict | None:
    """The compute stage's `params` output, as ONCE reads it; None when the
    apply reported none."""
    return cluster.output_params({"tofu/outputs": result.get("postgres-ha/outputs")})


def _non_blank(v) -> bool:
    return isinstance(v, str) and v.strip() != ""


def params_errors(params: dict) -> list[str]:
    """The extension keys this package puts inside `params`, which ONCE
    preserves but does not read: a non-blank `vpc_id` and a canonical
    `vpc_ip_range`, the network every etcd, Patroni and firewall rule is
    scoped to. A real run is refused without them; the legacy translation is
    held to the same rule."""
    errors: list[str] = []
    if not _non_blank(params.get("vpc_id")):
        errors.append("compute state carries no vpc_id")
    if not _non_blank(params.get("vpc_ip_range")):
        errors.append("compute state carries no vpc_ip_range")
    elif not cluster.ipv4_network(params.get("vpc_ip_range")):
        errors.append(f"compute state vpc_ip_range {json.dumps(params.get('vpc_ip_range'))}"
                      " is not a canonical IPv4 network such as 10.40.0.0/24")
    return errors


def _checked(opts: dict) -> dict:
    """`opts` once the adopted cluster passes `params_errors`, or the refusal."""
    errors = params_errors(opts["once/cluster"]) if "once/cluster" in opts else []
    return _refuse(opts, errors) if errors else opts


def resolve_infrastructure(opts: dict, result: dict) -> dict:
    """What the infrastructure stage hands on after its apply: `result` as it
    is on a failure, a delete or a build, and otherwise ONCE's
    `resolved_cluster` over the apply's `params` output — None outputs and a
    partial cluster are refused there — checked against `params_errors`.
    Pure, so the wiring is testable without an apply."""
    if failed(result):
        return result
    if opts.get("blue/event") in ("delete", "build"):
        return result
    resolved = cluster.resolved_cluster(validate.spec, opts, result, {}, output_params(result))
    return resolved if failed(resolved) else _checked(resolved)


async def infrastructure_step(opts: dict) -> dict:
    result = await tofu.tofu_with_spec(
        opts, infrastructure_specs(opts),
        dir=tool_dir(opts, infrastructure_tool),
        env=credential_env(opts, "provider-compute"),
        output_key="postgres-ha/outputs")
    return resolve_infrastructure(opts, result)


def legacy_params(opts: dict, outputs: dict) -> dict:
    """A state written before this package recorded `params`: the parallel
    `node_public_ips` and `node_private_ips` lists, zipped into the nodes the
    standard describes, with `vpc_id` and `vpc_ip_range` copied and the names
    this package has always given its nodes. Refused, as the SDK's
    `StepError`, when the two lists disagree with each other or with
    `cluster-nodes` — guessing which droplet is which is how a delete destroys
    around a node — and when no `vpc_id` or `vpc_ip_range` was recorded. The
    range's form is `params_errors`' to check, the same way for a legacy and
    a recorded state."""
    def as_list(v) -> list:
        return list(v) if isinstance(v, (list, tuple)) else []

    publics = as_list(outputs.get("node_public_ips"))
    privates = as_list(outputs.get("node_private_ips"))
    n = opts.get("cluster-nodes")
    if not (n == len(publics) == len(privates)):
        raise StepError(f"legacy state lists {len(publics)} public addresses and "
                        f"{len(privates)} private addresses; refusing to guess the cluster")
    for k in ("vpc_id", "vpc_ip_range"):
        if not _non_blank(outputs.get(k)):
            raise StepError(f"legacy state carries no {k}")
    return {"provider": validate.default_compute_provider,
            "vpc_id": outputs.get("vpc_id"),
            "vpc_ip_range": outputs.get("vpc_ip_range"),
            "nodes": [{"index": i,
                       "role": None,
                       "name": utils.node_name(opts, i + 1),
                       "ip": publics[i],
                       "vpc_ip": privates[i],
                       "user": "root",
                       "sudoer": "root"}
                      for i in range(n)]}


async def state_output(opts: dict) -> dict | None:
    """The reader ONCE's `read_state` takes: the compute `params` recorded in
    the infrastructure state, None when the state is readable and holds
    nothing, and the legacy translation when it holds only the pre-adoption
    outputs. Delete needs the cluster before it destroys anything — the local
    SSH configuration is keyed by it — and a `plan` at that moment would be a
    second chance to change infrastructure on the way to removing it; nor can
    a fresh clone re-derive it, so the stage is rendered, its backend written
    and initialized here, before the read. A failed initialization raises the
    SDK's `StepError`, the shape `blue.tofu` raises on an unreadable backend;
    `read_state` reports both fail-closed. Kept local, and looked up on this
    module at call time, so tests can replace it."""
    dir = tool_dir(opts, infrastructure_tool)
    credentials = credential_env(opts, "provider-compute")
    scaffold({**opts, "blue/event": "build"}, infrastructure_specs(opts))
    backend_advice(infrastructure_tool)(opts)
    init = await runtime.exec(
        ["tofu", f"-chdir={dir}", "init", "-input=false", "-no-color"],
        env=credentials)
    if init.exit != 0:
        raise StepError("infrastructure state initialization failed: "
                        f"{init.err or init.out or '(no output)'}")
    outputs = await tofu.outputs(dir, credentials)
    if "params" in outputs:
        return outputs["params"]
    if not outputs:
        return None
    return legacy_params(opts, outputs)


async def load_infrastructure_step(opts: dict) -> dict:
    """Adopt the cluster out of remote state without planning or mutating
    cloud resources: ONCE's `adopt_state` over the read `start_step` handed
    on under `postgres-ha/state`, or a fresh read when nothing was. An
    unreadable backend and a partial cluster fail closed; the adopted
    `params` must then pass `params_errors`. A readable state without a
    cluster means there is nothing to clean up on a delete."""
    event = str(opts.get("blue/event"))
    if "postgres-ha/state" in opts:
        state = opts["postgres-ha/state"]
    else:
        state = await cluster.read_state(opts, state_output)
    handed = {k: v for k, v in opts.items() if k != "postgres-ha/state"}
    adopted = cluster.adopt_state(validate.spec, handed, event, state)
    present = "once/cluster" in adopted
    if failed(adopted):
        return adopted
    checked = _checked(adopted)
    if failed(checked):
        return checked
    return {**checked, "postgres-ha/infrastructure-present?": present}


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


def private_key_file(opts: dict) -> str:
    """The private key every play and the acceptance script reach the nodes
    with: the generated key's path in keygen mode (the build placeholder on a
    build or a dry-run), the operator's `digitalocean-ssh-private-key` in
    opt-out mode."""
    if validate.keygen(opts):
        return str(opts.get("ssh-private-key-path"))
    return str(opts.get("digitalocean-ssh-private-key") or "")


def data_fn(opts: dict) -> dict:
    """Template data: the topology, the adopted cluster's `vpc_ip_range`
    winning over the fallback on a real run, and the machine-key paths keygen
    mode owns."""
    opts = ssh.with_machine_key(opts)
    ns = nodes(opts)
    recorded = opts.get("once/cluster") or {}
    facts = {**fallback_outputs, **{k: recorded[k] for k in fallback_outputs if k in recorded}}
    etcd_version = str(opts.get("etcd-version") or "")
    return {
        **opts,
        "nodes": ns,
        "first-node": ns[0],
        "vpc-cidr": facts["vpc_ip_range"],
        "ssh-private-key": private_key_file(opts),
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


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. Addresses are run-time facts and
    reach the play as extra-vars instead, so the rendered playbook carries no
    IP and is identical on every workstation (SSH Config Standard §6)."""
    return {**data_fn(opts),
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts),
            "host-alias": ssh_config.host_alias(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    return [
        spec(template("ansible-local", "ansible.cfg"), f"{dir}/ansible.cfg", data),
        spec(template("ansible-local", "inventory.ini"), f"{dir}/inventory.ini", data),
        spec(template("ansible-local", "main.yml"), f"{dir}/main.yml", data),
    ]


def ssh_config_hosts(opts: dict) -> list[dict]:
    """The `~/.ssh/config` entries, as data the play loops over: the bare
    profile pointing at node 0 (the spec's entry), then one alias per node.
    ONCE's (Compute Cluster Standard §6)."""
    return cluster.ssh_config_hosts(validate.spec, opts, _cluster_nodes(opts))


def ansible_local_extra_vars(opts: dict) -> dict:
    """What the play cannot know from a `build`: the aliases and addresses,
    which are run-time facts and stay out of the rendered playbook so the
    committed goldens carry no address (ssh-config.md §6), and `block_state`
    — `present` on create, `absent` on delete — because the same playbook
    file serves both events. The identity file is desired state a build does
    know and reaches the play through Selmer instead."""
    return {
        "host_alias": ssh_config.host_alias(opts),
        "ssh_hosts": ssh_config_hosts(opts),
        "block_state": "absent" if opts.get("blue/event") == "delete" else "present",
    }


async def ansible_local_step(opts: dict) -> dict:
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=tool_dir(opts, ansible_local_tool),
        inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars=ansible_local_extra_vars(opts))


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
