import tempfile
from pathlib import Path

from blue.cli import par_name
from package_postgres_ha_blue import tools, workflow

from conftest import fixture

FIXTURE = fixture()


def walk(event: str) -> list[str]:
    """Follow the static graph from postgres-ha/start for `event`."""
    step = "postgres-ha/start"
    seen: list[str] = []
    guard = 0
    while True:
        decl = workflow.wire_fn(step, {"blue/event": event})
        nexts = decl[1:]
        if guard > 20:
            return [*seen, "loop"]
        if not nexts:
            return [*seen, step]
        seen.append(step)
        step = nexts[0]
        guard += 1


def test_create_walks_compute_dns_local_cluster_acceptance():
    # strictly sequential: DNS needs the addresses compute produced, the
    # cluster play needs the inventory those addresses build, and acceptance
    # needs both a converged cluster and a resolvable name
    assert walk("create") == [
        "postgres-ha/start", "postgres-ha/infrastructure", "postgres-ha/dns",
        "postgres-ha/ansible-local", "postgres-ha/cluster", "postgres-ha/acceptance"]


def test_delete_runs_the_same_edges_backwards_after_loading_state():
    # the local SSH configuration delete has to withdraw is keyed by addresses
    # that may already be gone, so they are read from remote state before
    # anything is destroyed
    assert walk("delete") == [
        "postgres-ha/start", "postgres-ha/load-infrastructure",
        "postgres-ha/cluster", "postgres-ha/ansible-local", "postgres-ha/dns",
        "postgres-ha/infrastructure", "postgres-ha/generated-cleanup"]


def test_build_follows_the_create_graph():
    assert walk("build") == walk("create")


def test_every_side_effecting_step_is_skipped_by_dry_run():
    # a step that reaches a provider and is not in this list makes --dry-run
    # a lie
    effecting = set(workflow.side_effecting_steps)
    for step in [*walk("create"), *walk("delete")]:
        if step == "postgres-ha/start":
            continue
        assert step in effecting, step


def test_remote_state_keys_are_per_stage_and_profile_scoped():
    advice = workflow.backend_advice(tools.infrastructure_tool)
    dir = tempfile.mkdtemp(prefix="postgres-ha-backend-")
    opts = {**FIXTURE, "workdir": dir}
    advice(opts)
    written = (Path(tools.tool_dir(opts, tools.infrastructure_tool))
               / "backend.tf.json").read_text()
    assert "postgres-ha-fixture/postgres-ha-infrastructure.tfstate" in written
    assert "fixture-state" in written
    # R2 authenticates through the AWS environment chain; naming the keys in
    # the backend document would write them to disk
    assert "access_key" not in written
    assert "secret_key" not in written


async def test_a_build_needs_no_credential():
    # which is what makes build and --dry-run the safe way to review a
    # colors.yml edit on a fresh checkout
    result = await workflow.start_step({**FIXTURE, "blue/event": "build"}, {})
    assert result["blue/exit"] == 0


async def test_a_real_create_demands_every_credential():
    result = await workflow.start_step({**FIXTURE, "blue/event": "create"}, {})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_POSTGRES_ADMIN_PASSWORD" in result["blue/err"]
    assert "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY" in result["blue/err"]


async def test_a_dry_run_create_demands_none():
    result = await workflow.start_step(
        {**FIXTURE, "blue/event": "create", "blue/dry-run": True}, {})
    assert result["blue/exit"] == 0


async def test_destruction_stays_guarded():
    credentials = {
        "COLORS_PAR_DO_TOKEN": "t", "COLORS_PAR_CLOUDFLARE_API_TOKEN": "t",
        "COLORS_PAR_R2_ACCESS_KEY_ID": "t", "COLORS_PAR_R2_SECRET_ACCESS_KEY": "t",
        "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID": "t",
        "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY": "t",
        "COLORS_PAR_POSTGRES_ADMIN_PASSWORD": "t",
        "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD": "t",
    }
    guarded = await workflow.start_step({**FIXTURE, "blue/event": "delete"}, credentials)
    assert guarded["blue/exit"] == 2
    assert "compute destruction is protected" in guarded["blue/err"]
    # and is lifted for exactly one run, from the environment, never by
    # editing the committed flag
    lifted = await workflow.start_step(
        {**FIXTURE, "blue/event": "delete"},
        {**credentials, "COLORS_PAR_COMPUTE_PREVENT_DESTROY": "false"})
    assert lifted["blue/exit"] == 0


async def test_the_profile_overlay_is_refused():
    result = await workflow.start_step({**FIXTURE, "blue/event": "build"},
                                       {par_name("profile"): "elsewhere"})
    assert result["blue/exit"] == 2
    assert "profile" in result["blue/err"]


def test_defaults_describe_a_working_cluster_on_their_own():
    # a deployment should only have to say what is specific to it
    assert workflow.DEFAULTS["compute-prevent-destroy"] is True
    assert workflow.DEFAULTS["cluster-nodes"] == 3
    assert workflow.DEFAULTS["patroni-synchronous-node-count"] == 1
    assert workflow.DEFAULTS["cloudflare-proxied"] is False
    assert workflow.DEFAULTS["digitalocean-vpc-mode"] == "default"
