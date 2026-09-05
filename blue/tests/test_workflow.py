import tempfile
from pathlib import Path

import pytest
from blue.cli import par_name
from blue.workflow import StepError
from package_postgres_ha_blue import tools, workflow

from conftest import fixture

FIXTURE = fixture()

CREDENTIALS = {
    "COLORS_PAR_DO_TOKEN": "t", "COLORS_PAR_CLOUDFLARE_API_TOKEN": "t",
    "COLORS_PAR_R2_ACCESS_KEY_ID": "t", "COLORS_PAR_R2_SECRET_ACCESS_KEY": "t",
    "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID": "t",
    "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY": "t",
    "COLORS_PAR_POSTGRES_ADMIN_PASSWORD": "t",
    "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD": "t",
}
UNGUARDED = {**CREDENTIALS, "COLORS_PAR_COMPUTE_PREVENT_DESTROY": "false"}


def recorded() -> dict:
    """`params` as a converged deployment records it."""
    return {"provider": "digitalocean",
            "vpc_id": "5a6b7c8d-0000-4000-8000-000000000001",
            "vpc_ip_range": "10.20.0.0/20",
            "nodes": [{"index": i, "role": None, "name": f"postgres-ha-fixture-{i + 1}",
                       "ip": f"203.0.113.{i + 1}", "vpc_ip": f"10.20.0.{i + 1}",
                       "user": "root", "sudoer": "root"}
                      for i in range(3)]}


# The compute state is read once per run, through `tools.state_output`, on a
# real create or delete. Every lifecycle test replaces it: None is a readable
# state holding no compute, a dict is a recorded `params`, and a raise is a
# backend that cannot be read.
@pytest.fixture
def state(monkeypatch):
    def install(value):
        async def stub(_opts):
            return value
        monkeypatch.setattr(tools, "state_output", stub)
    return install


@pytest.fixture
def unreadable(monkeypatch):
    # The shape `blue.tofu` raises: the SDK's StepError. Only that is an
    # unreadable backend; anything else propagates as a defect.
    async def boom(_opts):
        raise StepError("tofu output failed: no backend")
    monkeypatch.setattr(tools, "state_output", boom)


@pytest.fixture
def never(monkeypatch):
    async def boom(_opts):
        raise AssertionError("the reader must not run")
    monkeypatch.setattr(tools, "state_output", boom)


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
    # the local SSH configuration delete has to withdraw is keyed by nodes
    # that may already be gone, so the cluster is adopted out of remote state
    # before anything is destroyed
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


async def test_build_and_dry_run_never_read_the_state(never):
    # a raising reader proves nothing on these paths reaches the backend
    for opts in [fixture({"blue/event": "build"}),
                 fixture({"blue/event": "create", "blue/dry-run": True}),
                 fixture({"blue/event": "delete", "blue/dry-run": True})]:
        result = await workflow.start_step(opts, env={})
        assert result["blue/exit"] == 0
        assert "postgres-ha/state" not in result


async def test_a_real_create_demands_every_credential(state):
    state(None)
    result = await workflow.start_step({**FIXTURE, "blue/event": "create"}, {})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_POSTGRES_ADMIN_PASSWORD" in result["blue/err"]
    assert "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY" in result["blue/err"]


async def test_a_dry_run_create_demands_none():
    result = await workflow.start_step(
        {**FIXTURE, "blue/event": "create", "blue/dry-run": True}, {})
    assert result["blue/exit"] == 0


async def test_destruction_stays_guarded(state):
    state(None)
    guarded = await workflow.start_step({**FIXTURE, "blue/event": "delete"}, CREDENTIALS)
    assert guarded["blue/exit"] == 2
    assert "compute destruction is protected" in guarded["blue/err"]
    # and is lifted for exactly one run, from the environment, never by
    # editing the committed flag
    lifted = await workflow.start_step({**FIXTURE, "blue/event": "delete"}, UNGUARDED)
    assert lifted["blue/exit"] == 0


async def test_the_profile_overlay_is_refused(never):
    result = await workflow.start_step({**FIXTURE, "blue/event": "build"},
                                       {par_name("profile"): "elsewhere"})
    assert result["blue/exit"] == 2
    assert "profile" in result["blue/err"]
    # and the state is not read for a refused profile, nor for invalid
    # desired state
    result = await workflow.start_step(
        {**FIXTURE, "blue/event": "delete"}, {**UNGUARDED, par_name("profile"): "elsewhere"})
    assert result["blue/exit"] == 2
    result = await workflow.start_step(
        {**FIXTURE, "blue/event": "delete", "cluster-nodes": 2}, UNGUARDED)
    assert result["blue/exit"] == 2


def test_defaults_describe_a_working_cluster_on_their_own():
    # a deployment should only have to say what is specific to it
    assert workflow.DEFAULTS["compute-prevent-destroy"] is True
    assert workflow.DEFAULTS["cluster-nodes"] == 3
    assert workflow.DEFAULTS["patroni-synchronous-node-count"] == 1
    assert workflow.DEFAULTS["cloudflare-proxied"] is False
    assert workflow.DEFAULTS["digitalocean-vpc-mode"] == "default"
    assert workflow.DEFAULTS["provider-compute"] == "digitalocean"


# --- the Compute Cluster Standard's safety boundaries -----------------------

async def test_a_provider_switch_is_refused_before_the_credentials(state):
    state({**recorded(), "provider": "vultr"})
    for event in ("create", "delete"):
        r = await workflow.start_step(
            {**FIXTURE, "blue/event": event}, {"COLORS_PAR_COMPUTE_PREVENT_DESTROY": "false"})
        assert r["blue/exit"] == 2, event
        assert "state holds a vultr machine; set provider-compute back to vultr and delete first" \
            in r["blue/err"]
        # the validator order is the thing under test: the actionable error,
        # not a missing token for the provider that was just selected
        assert "required credential is not set" not in r["blue/err"]


async def test_legacy_state_accepts_only_the_default_provider(state):
    # a recorded provider is absent from every pre-adoption state; on the one
    # provider this package offers that is the default, and the run proceeds
    # to its credentials. A second provider would be refused by selection
    # before the state is read, so the other branch of the rule has no
    # reachable input here
    state({k: v for k, v in recorded().items() if k != "provider"})
    for event in ("create", "delete"):
        r = await workflow.start_step(
            {**FIXTURE, "blue/event": event}, {"COLORS_PAR_COMPUTE_PREVENT_DESTROY": "false"})
        assert r["blue/exit"] == 2, event
        assert "state holds" not in r["blue/err"], event
        assert "required credential is not set" in r["blue/err"], event


async def test_a_matching_provider_passes_to_the_credentials(state):
    state(recorded())
    r = await workflow.start_step({**FIXTURE, "blue/event": "create"}, {})
    assert r["blue/exit"] == 2
    assert "state holds" not in r["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in r["blue/err"]


async def test_an_unreadable_backend_counts_as_no_state_on_create(unreadable):
    # a fresh clone has no readable state and must still be able to create
    r = await workflow.start_step({**FIXTURE, "blue/event": "create"}, {})
    assert r["blue/exit"] == 2
    assert "could not read" not in r["blue/err"]
    assert "state holds" not in r["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in r["blue/err"]


async def test_a_real_create_on_a_fresh_work_directory_reports_the_credentials_not_a_crash(tmp_path):
    # no reader stub: the real `state_output` runs against a work directory
    # that holds no stage yet, as a fresh clone's does. It renders the stage,
    # writes its backend and initializes it, and finds no state — or fails to
    # launch or initialize tofu, which the SDK reports as its StepError.
    # Either way ONCE's `read_state` counts it as no usable state, so the
    # create reports its credentials instead of crashing
    result = await workflow.start_step(
        {**FIXTURE, "workdir": str(tmp_path), "blue/event": "create"}, {})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "could not read" not in result["blue/err"]


async def test_an_unreadable_backend_fails_a_real_delete_closed(unreadable):
    # swallowing it is how a teardown ends up converging against 192.0.2.11.
    # Preflight hands the read on; `load-infrastructure`, the first step after
    # it and before any side effect, is where the delete stops
    r = await workflow.start_step({**FIXTURE, "blue/event": "delete"}, UNGUARDED)
    assert r["blue/exit"] == 0
    assert r["postgres-ha/state"] == {"error": "tofu output failed: no backend"}
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in loaded["blue/err"]
    assert "no backend" in loaded["blue/err"]


async def test_a_real_delete_adopts_the_recorded_cluster(state):
    state(recorded())
    r = await workflow.start_step({**FIXTURE, "blue/event": "delete"}, UNGUARDED)
    assert r["blue/exit"] == 0
    assert r["postgres-ha/state"] == {"params": recorded()}
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 0
    assert loaded["once/cluster"] == recorded()
    assert [n["public-ip"] for n in tools.nodes(loaded)] == \
        ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    # and withdraws every alias of the block it wrote
    variables = tools.ansible_local_extra_vars(loaded)
    assert [h["name"] for h in variables["ssh_hosts"]] == \
        ["postgres-ha-fixture", "postgres-ha-fixture-0", "postgres-ha-fixture-1", "postgres-ha-fixture-2"]
    assert variables["block_state"] == "absent"
    # a readable state without a cluster leaves nothing to clean up
    state(None)
    r = await workflow.start_step({**FIXTURE, "blue/event": "delete"}, UNGUARDED)
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 0
    assert loaded["postgres-ha/infrastructure-present?"] is False


async def test_a_partial_cluster_is_refused_on_a_real_run(state):
    params = recorded()
    state({**params, "nodes": params["nodes"][:2]})
    r = await workflow.start_step({**FIXTURE, "blue/event": "delete"}, UNGUARDED)
    # the switch guard reads only the provider
    assert r["blue/exit"] == 0
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 1
    assert loaded["blue/err"] == "the compute stage did not report nodes this package declares: 2"
