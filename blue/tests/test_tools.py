import json
from pathlib import Path

from package_postgres_ha_blue import tools

from conftest import fixture

FIXTURE = fixture()
CONVERGED = fixture({
    "node_public_ips": ["203.0.113.1", "203.0.113.2", "203.0.113.3"],
    "node_private_ips": ["10.20.0.1", "10.20.0.2", "10.20.0.3"],
    "vpc_ip_range": "10.20.0.0/20",
})


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
    ns = tools.nodes(FIXTURE)
    assert len(ns) == 3
    # TEST-NET-1, so a golden that leaked into a real run points at nobody
    assert all(n["public-ip"].startswith("192.0.2.") for n in ns)
    assert [n["name"] for n in ns] == \
        ["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]


def test_converged_addresses_replace_the_placeholders_in_ordinal_order():
    ns = tools.nodes(CONVERGED)
    assert [n["public-ip"] for n in ns] == ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
    assert [n["private-ip"] for n in ns] == ["10.20.0.1", "10.20.0.2", "10.20.0.3"]
    assert [n["ordinal"] for n in ns] == [1, 2, 3]


def test_the_inventory_carries_exactly_what_the_templates_read():
    inv = json.loads(tools.inventory(CONVERGED))
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


def test_derived_values_match_what_the_tools_actually_accept():
    data = tools.data_fn(CONVERGED)
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
