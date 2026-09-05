import json
from pathlib import Path

import pytest
from blue.workflow import StepError
from package_once_blue import compute_cluster as cluster
from package_postgres_ha_blue import tools, validate

from conftest import fixture

FIXTURE = fixture()

# A pre-adoption state exactly as `tofu output -json` parsed it: the four
# outputs, two parallel lists among them, and no `params`.
LEGACY_OUTPUTS = {
    "node_public_ips": ["203.0.113.1", "203.0.113.2", "203.0.113.3"],
    "node_private_ips": ["10.20.0.1", "10.20.0.2", "10.20.0.3"],
    "vpc_id": "5a6b7c8d-0000-4000-8000-000000000001",
    "vpc_ip_range": "10.20.0.0/20",
}


def recorded() -> dict:
    """`params` as the adopted template records it, here through the legacy
    translation so the two shapes are provably one."""
    return tools.legacy_params(FIXTURE, LEGACY_OUTPUTS)


def without(mapping: dict, key: str) -> dict:
    return {k: v for k, v in mapping.items() if k != key}


def converged() -> dict:
    return fixture({"once/cluster": recorded()})


def test_stage_directories_and_state_keys_are_the_deployment_identity():
    # these two strings address live infrastructure; moving either orphans a
    # cluster, so they are asserted rather than derived at the call site
    assert tools.tool_dir(FIXTURE, tools.infrastructure_tool).endswith(
        ".colors/postgres-ha-fixture/postgres-ha-infrastructure")
    assert tools.tofu_tools == ["postgres-ha-infrastructure", "postgres-ha-dns"]
    assert tools.cluster_tool == "postgres-ha-cluster"
    assert tools.ansible_local_tool == "postgres-ha-ansible-local"
    assert tools.acceptance_tool == "postgres-ha-acceptance"


def test_a_build_renders_placeholder_addresses_not_real_ones():
    # ONCE's fallbacks at offset 11 are the addresses this package always
    # rendered; documentation range, so a golden that leaked into a real run
    # points at nobody
    ns = tools.nodes(FIXTURE)
    assert len(ns) == 3
    assert [n["public-ip"] for n in ns] == ["192.0.2.11", "192.0.2.12", "192.0.2.13"]
    assert [n["private-ip"] for n in ns] == ["10.114.0.11", "10.114.0.12", "10.114.0.13"]
    assert [n["ordinal"] for n in ns] == [1, 2, 3]
    # the package's names, not ONCE's fallback rule
    assert [n["name"] for n in ns] == \
        ["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]
    assert tools.data_fn(FIXTURE)["vpc-cidr"] == "10.114.0.0/20"
    assert tools.nodes(FIXTURE) == tools.nodes(FIXTURE)


def test_the_aliases_are_the_standards():
    # Compute Cluster Standard §6: the bare profile reaches node 0, then
    # `<profile>-<index>`; `--node N` is 1-based and lands on index N-1.
    assert [n["alias"] for n in tools.nodes(FIXTURE)] == \
        ["postgres-ha-fixture-0", "postgres-ha-fixture-1", "postgres-ha-fixture-2"]
    assert tools.ssh_alias(FIXTURE, 1) == "postgres-ha-fixture-0"
    assert tools.ssh_alias(FIXTURE, 3) == "postgres-ha-fixture-2"
    assert cluster.aliases(validate.spec, FIXTURE)[1:] == [n["alias"] for n in tools.nodes(FIXTURE)]


def test_a_real_run_reads_every_node_from_the_adopted_cluster():
    opts = converged()
    ns = tools.nodes(opts)
    assert [n["public-ip"] for n in ns] == ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    assert [n["private-ip"] for n in ns] == ["10.20.0.1", "10.20.0.2", "10.20.0.3"]
    assert [n["ordinal"] for n in ns] == [1, 2, 3]
    assert [n["name"] for n in ns] == \
        ["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]
    # the network facts beside the nodes come from state too
    assert tools.data_fn(opts)["vpc-cidr"] == "10.20.0.0/20"
    # and reach the inventory, the DNS records and the acceptance aliases
    inv = json.loads(tools.inventory(opts))
    assert inv["all"]["children"]["postgres"]["hosts"]["postgres-ha-fixture-2"]["ansible_host"] == "203.0.113.2"
    assert [n["public-ip"] for n in tools.dns_specs(opts)[0]["data"]["nodes"]] == \
        ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    assert [n["alias"] for n in tools.acceptance_specs(opts)[0]["data"]["nodes"]] == \
        ["postgres-ha-fixture-0", "postgres-ha-fixture-1", "postgres-ha-fixture-2"]


def test_the_legacy_state_is_translated_into_params():
    params = recorded()
    assert params["provider"] == "digitalocean"
    assert [n["index"] for n in params["nodes"]] == [0, 1, 2]
    assert all(n["role"] is None for n in params["nodes"])
    assert [n["name"] for n in params["nodes"]] == \
        ["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]
    second = params["nodes"][1]
    assert {k: second[k] for k in ["ip", "vpc_ip", "user", "sudoer"]} == \
        {"ip": "203.0.113.2", "vpc_ip": "10.20.0.2", "user": "root", "sudoer": "root"}
    assert [params[k] for k in ["vpc_id", "vpc_ip_range"]] == \
        ["5a6b7c8d-0000-4000-8000-000000000001", "10.20.0.0/20"]
    # ONCE accepts the translation as a whole cluster
    assert not cluster.node_errors(validate.spec, FIXTURE, params)
    assert tools.params_errors(params) == []


def test_the_legacy_translation_refuses_to_guess():
    def refusal(outputs):
        with pytest.raises(StepError) as e:
            tools.legacy_params(FIXTURE, outputs)
        return str(e.value)

    # lists that disagree with each other; the SDK's StepError, so read_state
    # reports it
    assert refusal({**LEGACY_OUTPUTS, "node_public_ips": ["203.0.113.1", "203.0.113.2"]}) == \
        "legacy state lists 2 public addresses and 3 private addresses; refusing to guess the cluster"
    # lists that disagree with cluster-nodes
    four = {k: [*LEGACY_OUTPUTS[k], LEGACY_OUTPUTS[k][-1]]
            for k in ["node_public_ips", "node_private_ips"]}
    assert refusal({**LEGACY_OUTPUTS, **four}) == \
        "legacy state lists 4 public addresses and 4 private addresses; refusing to guess the cluster"
    # no network
    assert refusal(without(LEGACY_OUTPUTS, "vpc_id")) == "legacy state carries no vpc_id"
    assert refusal({**LEGACY_OUTPUTS, "vpc_id": " "}) == "legacy state carries no vpc_id"
    assert refusal(without(LEGACY_OUTPUTS, "vpc_ip_range")) == "legacy state carries no vpc_ip_range"
    # the range's form is params_errors' to refuse, the same as a recorded state
    assert tools.params_errors(tools.legacy_params(FIXTURE, {**LEGACY_OUTPUTS, "vpc_ip_range": "10.20.0.1/20"})) == \
        ['compute state vpc_ip_range "10.20.0.1/20" is not a canonical IPv4 network such as 10.40.0.0/24']


def test_params_errors_hold_the_extension_keys():
    params = recorded()
    assert tools.params_errors(params) == []
    assert tools.params_errors(without(params, "vpc_id")) == ["compute state carries no vpc_id"]
    assert tools.params_errors({**params, "vpc_id": " "}) == ["compute state carries no vpc_id"]
    assert tools.params_errors({**params, "vpc_ip_range": None}) == \
        ["compute state carries no vpc_ip_range"]
    assert tools.params_errors({**params, "vpc_ip_range": "10.20.0.1/20"}) == \
        ['compute state vpc_ip_range "10.20.0.1/20" is not a canonical IPv4 network such as 10.40.0.0/24']
    assert tools.params_errors({}) == \
        ["compute state carries no vpc_id", "compute state carries no vpc_ip_range"]


async def test_load_infrastructure_adopts_the_state_preflight_handed_on():
    params = recorded()

    async def load(state):
        return await tools.load_infrastructure_step(
            fixture({"blue/event": "delete", "postgres-ha/state": state}))

    # a recorded cluster
    r = await load({"params": params})
    assert r["blue/exit"] == 0
    assert r["once/cluster"] == params
    assert r["postgres-ha/infrastructure-present?"] is True
    assert "postgres-ha/state" not in r
    assert [n["public-ip"] for n in tools.nodes(r)] == ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    # a readable state that records no cluster leaves nothing to clean up
    r = await load({"params": None})
    assert r["blue/exit"] == 0
    assert r["postgres-ha/infrastructure-present?"] is False
    assert "once/cluster" not in r
    # the ssh-config withdrawal is keyed by alias, so the fallbacks are harmless here
    assert [n["public-ip"] for n in tools.nodes(r)] == ["192.0.2.11", "192.0.2.12", "192.0.2.13"]
    # an unreadable backend fails closed
    r = await load({"error": "tofu output failed: no backend"})
    assert r["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in r["blue/err"]
    assert "no backend" in r["blue/err"]
    # a partial cluster is refused with ONCE's message
    r = await load({"params": {**params, "nodes": params["nodes"][:2]}})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "the compute stage did not report nodes this package declares: 2"
    # an adopted cluster without its extension keys is refused
    r = await load({"params": without(params, "vpc_id")})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "compute state carries no vpc_id"


def test_a_real_create_resolves_the_cluster_from_the_apply():
    # the apply's `params` output is what every later stage reads; never the
    # fallbacks
    params = recorded()
    opts = fixture({"blue/event": "create"})

    def apply(p):
        result = {**opts, "blue/exit": 0}
        if p is not None:
            result["postgres-ha/outputs"] = {"params": p}
        return tools.resolve_infrastructure(opts, result)

    r = apply(params)
    assert r["blue/exit"] == 0
    assert r["once/cluster"] == params
    assert [n["public-ip"] for n in tools.nodes(r)] == ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    r = apply(None)
    assert r["blue/exit"] == 1
    assert r["blue/err"] == cluster.NO_PARAMS_MESSAGE
    r = apply({**params, "nodes": params["nodes"][:2]})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "the compute stage did not report nodes this package declares: 2"
    r = apply(without(params, "vpc_ip_range"))
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "compute state carries no vpc_ip_range"
    # a failed apply, a delete and a build hand the result on untouched
    assert tools.resolve_infrastructure(opts, {**opts, "blue/exit": 1, "blue/err": "apply failed"})["blue/exit"] == 1
    assert "once/cluster" not in tools.resolve_infrastructure(
        {**opts, "blue/event": "build"}, {**opts, "blue/exit": 0})
    assert tools.resolve_infrastructure(
        {**opts, "blue/event": "delete"}, {**opts, "blue/exit": 0})["blue/exit"] == 0


def test_the_local_play_receives_one_block_of_aliases():
    # ssh-config.md: the addresses and the aliases are extra-vars, never
    # rendered; the marker is the profile; the bare profile reaches node 0
    variables = tools.ansible_local_extra_vars({**converged(), "blue/event": "create"})
    assert variables["host_alias"] == "postgres-ha-fixture"
    assert variables["ssh_hosts"] == [
        {"name": "postgres-ha-fixture", "ip": "203.0.113.1"},
        {"name": "postgres-ha-fixture-0", "ip": "203.0.113.1"},
        {"name": "postgres-ha-fixture-1", "ip": "203.0.113.2"},
        {"name": "postgres-ha-fixture-2", "ip": "203.0.113.3"},
    ]
    assert variables["block_state"] == "present"
    assert variables["ssh_private_key"] == "~/.ssh/id_ed25519"
    # the pre-standard per-node blocks are named so the play can remove them
    assert variables["legacy_aliases"] == \
        ["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]
    assert tools.ansible_local_extra_vars(fixture({"blue/event": "delete"}))["block_state"] == "absent"
    # a build renders the play without an address
    rendered = (Path(tools.ROOT) / "tools/ansible-local/main.yml").read_text()
    assert 'marker: "# {mark} {{ host_alias }} ANSIBLE MANAGED BLOCK"' in rendered
    assert "{% for host in ssh_hosts %}" in rendered
    assert "insertbefore: BOF" in rendered
    assert "192.0.2" not in rendered and "203.0.113" not in rendered


def test_the_inventory_carries_exactly_what_the_templates_read():
    inv = json.loads(tools.inventory(converged()))
    hosts = inv["all"]["children"]["postgres"]["hosts"]
    assert len(hosts) == 3
    # private_ip is what every etcd, Patroni and HAProxy stanza is built
    # from; a missing one renders a syntactically valid configuration for a
    # cluster that cannot form
    for host in hosts.values():
        assert host["private_ip"] is not None
        assert host["ansible_host"] is not None
        assert host["ansible_user"] == "root"
    assert inv["all"]["children"]["postgres"]["vars"]["ansible_ssh_private_key_file"] == \
        "~/.ssh/id_ed25519"


def test_the_hcl_lists_are_quoted_not_interpolated():
    data = tools.infrastructure_data(FIXTURE)
    assert data["node-names-hcl"] == \
        '["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]'
    assert data["ssh-sources-hcl"] == '["203.0.113.10/32"]'
    assert data["ssh-keys-hcl"] == '["12345678"]'
    # an overlay string renders the same list
    assert tools.infrastructure_data(
        fixture({"digitalocean-client-sources": "203.0.113.10/32, 198.51.100.0/24"}))["client-sources-hcl"] == \
        '["203.0.113.10/32", "198.51.100.0/24"]'


def test_derived_values_match_what_the_tools_actually_accept():
    data = tools.data_fn(converged())
    assert data["backup-r2-s3-endpoint"] == "account.r2.cloudflarestorage.com"
    assert data["backup-repo-path"] == "/postgres-ha-fixture"
    assert data["postgres-data-dir"] == "/var/lib/postgresql/17/main"
    assert data["postgres-bin-dir"] == "/usr/lib/postgresql/17/bin"
    assert data["vpc-cidr"] == "10.20.0.0/20"
    assert data["etcd-url"] == ("https://github.com/etcd-io/etcd/releases/download/"
                                "v3.5.33/etcd-v3.5.33-linux-amd64.tar.gz")


def test_every_scheduled_unit_is_both_rendered_and_installed():
    # two hand-maintained lists is how a unit ends up rendered but never
    # enabled, so the playbook loops over the same names this renders
    targets = {spec["target"] for spec in tools.cluster_specs(FIXTURE)}
    playbook = (Path(tools.ROOT) / "tools/ansible-remote/main.yml").read_text()
    for unit in tools.scheduled_work_templates:
        assert any(target.endswith(f"/templates/{unit}.j2") for target in targets), unit
        assert f"- {unit}\n" in playbook, unit


def test_the_cluster_stage_renders_a_complete_tree():
    targets = [spec["target"] for spec in tools.cluster_specs(FIXTURE)]
    for expected in ["/main.yml", "/cleanup.yml", "/ansible.cfg", "/inventory.json",
                     "/templates/patroni.yml.j2", "/templates/etcd.conf.yml.j2",
                     "/templates/haproxy.cfg.j2", "/templates/pgbackrest.conf.j2"]:
        assert any(target.endswith(expected) for target in targets), expected


def test_the_acceptance_credential_is_taken_from_opts():
    # reading the environment again here would let a COLORS_PAR_ overlay and
    # the value the workflow validated disagree
    assert tools.acceptance_env({**FIXTURE, "postgres-admin-password": "hunter2"}) == \
        {"PGPASSWORD": "hunter2"}


def test_tofu_credentials_reach_the_process_and_not_the_file():
    env = tools.credential_env(
        {**FIXTURE, "do-token": "tok", "r2-access-key-id": "ak",
         "r2-secret-access-key": "sk"},
        "provider-compute")
    assert env["DIGITALOCEAN_TOKEN"] == "tok"
    assert env["AWS_ACCESS_KEY_ID"] == "ak"
    assert env["AWS_SECRET_ACCESS_KEY"] == "sk"
    # an absent credential contributes no empty variable, which would look to
    # a provider like an explicit empty credential
    assert (tools.credential_env(FIXTURE, "provider-compute") or {}).get(
        "DIGITALOCEAN_TOKEN") is None
