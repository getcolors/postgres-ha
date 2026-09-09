from conftest import fixture, optout
from package_postgres_ha_blue import validate


def test_both_keypair_modes_are_renderable():
    # The SSH Keypair Standard has two modes and conformance means both hold.
    assert validate.state_errors(optout()) == []
    assert validate.keygen(fixture())
    assert not validate.keygen(optout())
    # The machine key is never required: its absence is keygen mode.
    assert not any("digitalocean-ssh-keys" in e for e in validate.state_errors(fixture()))


def test_the_private_key_path_is_desired_state_in_opt_out_mode_only():
    o = optout()
    del o["digitalocean-ssh-private-key"]
    assert ":ssh-private-key-path is required for external SSH access" \
        in validate.state_errors(o)
    k = fixture()
    k.pop("digitalocean-ssh-private-key", None)
    assert validate.state_errors(k) == []


def test_default_fixture_produces_no_errors():
    assert validate.state_errors(fixture()) == []


def test_profile_overlay_is_refused():
    assert validate.env_errors({"COLORS_PAR_PROFILE": "override"})
    assert validate.env_errors({}) == []


def test_missing_required_keys_are_reported():
    for key in ["profile", "digitalocean-region", "cluster-host"]:
        base = fixture()
        del base[key]
        assert validate.state_errors(base)


def test_cluster_nodes_must_be_3():
    assert validate.state_errors(fixture({"cluster-nodes": 2}))
    assert validate.state_errors(fixture({"cluster-nodes": 4}))
    assert validate.state_errors(fixture({"cluster-nodes": 3})) == []


def test_postgres_version_must_be_15_or_later():
    assert validate.state_errors(fixture({"postgres-version": 14}))
    assert validate.state_errors(fixture({"postgres-version": 16})) == []
    assert validate.state_errors(fixture({"postgres-version": 17})) == []


def test_patroni_synchronous_node_count_must_be_1_or_2():
    assert validate.state_errors(fixture({"patroni-synchronous-node-count": 1})) == []
    assert validate.state_errors(fixture({"patroni-synchronous-node-count": 2})) == []
    assert validate.state_errors(fixture({"patroni-synchronous-node-count": 3}))
    assert validate.state_errors(fixture({"patroni-synchronous-node-count": 0}))


def test_patroni_ttl_must_exceed_twice_loop_wait():
    assert validate.state_errors(fixture({"patroni-loop-wait": 15, "patroni-ttl": 30}))
    assert validate.state_errors(fixture({"patroni-loop-wait": 10, "patroni-ttl": 30})) == []


def test_exclusive_ports_must_not_collide():
    assert validate.state_errors(fixture({"patroni-rest-port": 2379, "etcd-client-port": 2379}))


def test_postgres_port_can_equal_haproxy_primary_port():
    assert validate.state_errors(fixture({"postgres-port": 5432, "haproxy-primary-port": 5432})) == []










def test_secret_errors_reported_when_credentials_missing():
    errors = validate.secret_errors(fixture())
    assert errors
    assert any("POSTGRES_ADMIN_PASSWORD" in e for e in errors)
    assert any("BACKUP_R2_ACCESS_KEY_ID" in e for e in errors)


def test_the_client_connect_timeout_is_desired_state_not_folklore():
    for value in (0, 120, None):
        assert any('client-connect-timeout-seconds' in error for error in validate.state_errors(fixture({'client-connect-timeout-seconds': value})))
    assert validate.state_errors(fixture({'client-connect-timeout-seconds': 5})) == []


def test_compute_provider_support_comes_from_library_without_package_allowlist():
    opts = fixture({'provider-compute': 'vultr', 'vultr-region': 'ams',
                    'vultr-plan': 'vc2-4c-8gb', 'vultr-os-id': 2284,
                    'vultr-vpc-subnet': '10.40.0.0/24',
                    'postgres-ssh-sources': ['192.0.2.0/24'],
                    'postgres-client-sources': ['198.51.100.0/24']})
    assert validate.state_errors(opts) == []
