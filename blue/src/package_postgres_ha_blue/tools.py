"""Application facts derived from the shared compute library."""

from __future__ import annotations

import json
import math
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.providers import tool_env
from package_once_blue.validate import providers as once_backends
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed
from colors_compute.orchestration import orchestrate
from colors_compute.planning import plan_deployment
from colors_compute.inspection import read_deployment

from . import compute, ssh, ssh_config, utils, validate

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
    return tool_env({**validate.providers, "provider-backend": once_backends["provider-backend"]}, opts, [*slots, "provider-backend"])


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
# subnet at offset 11 — and the network facts beside them are the stand-ins
# below. A golden file that leaked into a real run fails loudly rather than
# pointing at somebody's host, and the goldens stay a pure function of
# colors.yml.

def _cluster_nodes(opts):
    return compute.resolved(opts)


def ssh_alias(opts, n):
    return opts['profile'] + '-' + str(n - 1)


def nodes(opts: dict) -> list[dict]:
    """Application facts derived from the shared compute library."""
    members = []
    for node in _cluster_nodes(opts):
        ordinal = node["index"] + 1
        members.append({
            "ordinal": ordinal,
            "name": node.get("name"),
            "alias": ssh_alias(opts, ordinal),
            "public-ip": node.get("ip"),
            "private-ip": node.get("vpc_ip"),
            "user": node["user"],
        })
    return members


# ---------------------------------------------------------------------------
# Stage 1 — infrastructure


async def infrastructure_step(opts):
    planning = opts.get('blue/event') == 'build' or opts.get('blue/dry-run')
    result = plan_deployment(opts, compute.topology(opts), compute.requirements(opts)) if planning else await orchestrate(opts, compute.topology(opts), compute.requirements(opts))
    if result['status'] not in ('planned', 'ready', 'destroyed'):
        return _refuse(opts, ['compute lifecycle refused; legacy monolithic state requires explicit migration'])
    if planning:
        directory = Path(tool_dir(opts, infrastructure_tool))
        for stage, documents in [('shared', result['documents']['shared']), *[(f'nodes/{node}', docs) for node, docs in result['documents']['nodes'].items()]]:
            for name, document in documents.items():
                path = directory / stage / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(document, sort_keys=True, indent=2) + '\n')
    result_opts = {**opts, 'blue/exit': 0}
    if 'cluster' in result:
        result_opts['colors-compute/cluster'] = result['cluster']
        result_opts['colors-compute/shared'] = result.get('shared', {})
    path = result.get('key', {}).get('private_key_path')
    if path:
        result_opts['ssh-private-key-path'] = path.replace('$HOME/.ssh', '/home/build-placeholder/.ssh') if planning else path
    return result_opts


async def load_infrastructure_step(opts):
    if opts.get('blue/event') == 'build' or opts.get('blue/dry-run'):
        return await infrastructure_step(opts)
    result = await read_deployment(opts)
    if result['status'] == 'destroyed':
        return {**opts, 'postgres-ha/already-destroyed': True, 'blue/exit': 0}
    if result['status'] != 'present':
        return _refuse(opts, ['compute state unavailable; legacy monolithic state requires explicit migration'])
    handed = {**opts, 'colors-compute/cluster': result['cluster'], 'colors-compute/shared': result.get('shared', {}), 'postgres-ha/infrastructure-present?': True, 'blue/exit': 0}
    path = result.get('key', {}).get('private_key_path')
    if path:
        handed['ssh-private-key-path'] = path
    return handed


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


def private_key_file(opts):
    return opts.get('ssh-private-key-path') or ''


def data_fn(opts: dict) -> dict:
    """Template data: the topology, the adopted cluster's `vpc_ip_range`
    winning over the fallback on a real run, and the machine-key paths keygen
    mode owns."""
    opts = ssh.with_machine_key(opts)
    ns = nodes(opts)
    shared = opts.get('colors-compute/shared')
    if shared is None and (opts.get('blue/event') == 'build' or opts.get('blue/dry-run')):
        shared = plan_deployment(opts, compute.topology(opts), compute.requirements(opts)).get('shared', {})
    facts = (shared or {}).get('params', {})
    if not facts.get('network_cidr'):
        raise ValueError('compute shared network CIDR unavailable')
    etcd_version = str(opts.get("etcd-version") or "")
    return {
        **opts,
        "nodes": ns,
        "first-node": ns[0],
        "vpc-cidr": facts["network_cidr"],
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
            "ssh-config-identity-file": ssh_config.identity_file(opts) if validate.keygen(opts) else opts.get("ssh-private-key-path", ""),
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
    """Application facts derived from the shared compute library."""
    ns = _cluster_nodes(opts)
    return [{**ns[0], 'name': opts['profile']}, *[{**node, 'name': opts['profile'] + '-' + node['node_id']} for node in ns]]


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
        "ansible_user": node["user"],
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
