"""The lifecycle graph, the preflight, and the per-stage remote-state advice —
the port of io.github.getcolors.postgres-ha.workflow.

Create is strictly sequential. The stages are not independent: DNS needs the
addresses compute produced, the cluster play needs the inventory those
addresses build, and acceptance needs a converged cluster *and* a resolvable
name. Fanning any of it out would only buy back the seconds that DigitalOcean
spends creating three droplets in one `apply` anyway.

Delete runs the same edges backwards, with one addition: it loads the node
addresses out of remote state first, because the local SSH configuration it
has to withdraw is keyed by them and by then the droplets may already be
gone."""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, workflow

from . import tools, validate

DEFAULTS = {
    "provider-compute": "digitalocean",
    "provider-dns": "cloudflare",
    "provider-backend": "local",
    "compute-prevent-destroy": True,
    "workdir": ".colors",
    "cluster-nodes": 3,
    "cloudflare-proxied": False,
    "cloudflare-record-ttl": 60,
    "digitalocean-vpc-mode": "default",
    "postgres-port": 5432,
    "postgres-admin-user": "postgres",
    "postgres-replication-user": "replicator",
    "patroni-rest-port": 8008,
    "patroni-ttl": 30,
    "patroni-loop-wait": 10,
    "patroni-retry-timeout": 10,
    "patroni-synchronous-node-count": 1,
    "etcd-client-port": 2379,
    "etcd-peer-port": 2380,
    "haproxy-primary-port": 5432,
    "haproxy-replica-port": 5433,
    "haproxy-stats-port": 7000,
    "client-connect-timeout-seconds": 5,
    "backup-stanza": "main",
    "backup-retention-full": 4,
    "backup-r2-region": "auto",
    "restore-check-port": 5442,
    "restore-check-max-age-hours": 26,
    "restore-check-max-lag-seconds": 900,
    "heartbeat-oncalendar": "*:0/1",
    "heartbeat-retention-days": 7,
}

LIFECYCLE_EVENTS = ("create", "delete")


async def start_step(opts: dict, env: dict | None = None) -> dict:
    return await preflight(
        opts, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            # Credentials are only demanded by a run that will actually use
            # them. `build` and `--dry-run` therefore work on a fresh checkout
            # with an empty environment, which is what makes them a safe way
            # to review a colors.yml edit.
            lambda o, _e, c: (validate.secret_errors(o)
                              if c["real"] and c["event"] in LIFECYCLE_EVENTS else []),
            lambda o, _e, c: (["compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false for this one delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ])


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "postgres-ha/start": (start_step, "postgres-ha/load-infrastructure"),
            "postgres-ha/load-infrastructure": (tools.load_infrastructure_step,
                                                "postgres-ha/cluster"),
            "postgres-ha/cluster": (tools.cluster_step, "postgres-ha/ansible-local"),
            "postgres-ha/ansible-local": (tools.ansible_local_step, "postgres-ha/dns"),
            "postgres-ha/dns": (tools.dns_step, "postgres-ha/infrastructure"),
            "postgres-ha/infrastructure": (tools.infrastructure_step,
                                           "postgres-ha/generated-cleanup"),
            "postgres-ha/generated-cleanup": (tools.generated_cleanup_step,),
        }.get(step)
    return {
        "postgres-ha/start": (start_step, "postgres-ha/infrastructure"),
        "postgres-ha/infrastructure": (tools.infrastructure_step, "postgres-ha/dns"),
        "postgres-ha/dns": (tools.dns_step, "postgres-ha/ansible-local"),
        "postgres-ha/ansible-local": (tools.ansible_local_step, "postgres-ha/cluster"),
        "postgres-ha/cluster": (tools.cluster_step, "postgres-ha/acceptance"),
        "postgres-ha/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile')}/{tool}.tfstate")


side_effecting_steps = [
    "postgres-ha/load-infrastructure", "postgres-ha/infrastructure",
    "postgres-ha/dns", "postgres-ha/ansible-local", "postgres-ha/cluster",
    "postgres-ha/acceptance", "postgres-ha/generated-cleanup",
]


def create_workflow():
    wf = workflow(start="postgres-ha/start", wire_fn=wire_fn)
    wf = advice_add(wf, "postgres-ha/load-infrastructure", "before",
                    "io.github.getcolors.postgres-ha.workflow/backend",
                    backend_advice(tools.infrastructure_tool))
    wf = advice_add(wf, "postgres-ha/infrastructure", "before",
                    "io.github.getcolors.postgres-ha.workflow/backend",
                    backend_advice(tools.infrastructure_tool))
    wf = advice_add(wf, "postgres-ha/dns", "before",
                    "io.github.getcolors.postgres-ha.workflow/backend",
                    backend_advice(tools.dns_tool))
    wf = progress.advise(wf)
    wf = dry_run.advise(wf, side_effecting_steps)
    return wf


postgres_ha_workflow = create_workflow()
