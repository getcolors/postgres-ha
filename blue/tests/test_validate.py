import re

from blue.cli import par_name
from package_once_blue import compute_cluster as cluster
from package_postgres_ha_blue import validate

from conftest import fixture

FIXTURE = fixture()


def errors(overrides: dict) -> list[str]:
    return validate.state_errors({**FIXTURE, **overrides})


def has(messages, pattern: str) -> bool:
    return any(re.search(pattern, m) for m in messages)


def test_the_fixture_is_renderable():
    # the golden fixture must stay valid, or the golden proves nothing
    assert validate.state_errors(FIXTURE) == []


def test_every_problem_is_reported_at_once():
    # a person fixing desired state one error per run gives up on it
    messages = errors({"cluster-host": None, "postgres-database": "Not An Ident",
                       "backup-retention-full": 0, "etcd-sha256": "nope"})
    assert len(messages) >= 4
    assert has(messages, r":cluster-host is required")
    assert has(messages, r"postgres-database must be an unquoted lowercase SQL identifier")
    assert has(messages, r"backup-retention-full must be a positive integer")
    assert has(messages, r"etcd-sha256 must be the lowercase hex SHA-256")


def test_the_profile_overlay_is_refused():
    par = par_name("profile")
    assert validate.env_errors({}) is None
    assert validate.env_errors({par: ""}) is None
    assert has(validate.env_errors({par: "somebody-elses-deployment"}),
               r"takes profile from colors\.yml only")


def test_the_spec_describes_one_homogeneous_role_on_a_discovered_network():
    # The Compute Cluster Standard's spec is data ONCE reads; this is the one
    # place its content is asserted, so a drift in any colour is a test
    # failure and not a rendered surprise.
    assert cluster.spec_errors(validate.spec) == []
    assert list(validate.spec["registry"]) == ["digitalocean"]
    assert validate.spec["default"] == "digitalocean"
    assert validate.spec["registry"]["digitalocean"]["network"] == {"mode": "discovered"}
    assert validate.spec["sources"] == {"non_empty": ["ssh-sources", "client-sources"], "may_be_empty": []}
    assert validate.spec["roles"] == [
        {"role": None, "count_key": "cluster-nodes", "count": 3, "fallback_offset": 11}]
    # the bare profile alias reaches node 0
    assert "entry" not in validate.spec
    assert validate.spec["fallback_subnet"] == "10.114.0.0/20"
    assert cluster.topology_errors(validate.spec, FIXTURE) == []
    # the registry's required keys are demanded through ONCE
    for key in validate.compute_providers["digitalocean"]["required"]:
        assert has(errors({key: None}), f"{key} is required"), key


def test_the_vpc_is_discovered_and_cannot_be_described():
    # accepting a VPC identifier would let one deployment be edited onto
    # another's private network while passing every other check
    for key in validate.forbidden_vpc_keys:
        assert has(errors({key: "10.0.0.0/16"}),
                   r"must not be configured; the regional default VPC is discovered"), key
    # the two spellings ONCE knows are refused by its discovered-network rule,
    # once, with its message
    assert errors({"digitalocean-vpc-uuid": "00000000-0000-0000-0000-000000000000"}) == \
        [":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"]
    assert errors({"digitalocean-vpc-cidr": "10.114.0.0/20"}) == \
        [":digitalocean-vpc-cidr must be absent; this package must not create a VPC"]
    assert has(errors({"digitalocean-vpc-mode": "explicit"}),
               r":digitalocean-vpc-mode must be default")


def test_the_node_budget_is_fixed():
    assert has(errors({"cluster-nodes": 2}), r":cluster-nodes must be 3")
    assert has(errors({"cluster-nodes": 5}), r":cluster-nodes must be 3")
    # a count that is not a positive integer is ONCE's to refuse too
    assert has(errors({"cluster-nodes": "3"}), r":cluster-nodes must be a positive integer")


def test_only_the_providers_this_package_implements_are_accepted():
    assert has(errors({"provider-compute": "hcloud"}), r":provider-compute must be one of digitalocean")
    assert has(errors({"provider-dns": "yandex"}), r"unsupported :provider-dns")
    assert has(errors({"provider-backend": "gcs"}), r"unsupported :provider-backend")


def test_ports_that_share_an_address_must_differ():
    # the primary listener deliberately reuses the PostgreSQL port, because
    # HAProxy binds the public address and PostgreSQL the private one
    assert errors({"haproxy-primary-port": 5432, "postgres-port": 5432}) == []
    assert has(errors({"haproxy-replica-port": 5432}),
               r":haproxy-replica-port must differ from :postgres-port")
    assert has(errors({"etcd-client-port": 8008}), r"port 8008 is claimed by")
    assert has(errors({"restore-check-port": 7000}), r"port 7000 is claimed by")


def test_quorum_settings_cannot_describe_a_cluster_that_stalls():
    # requiring every standby to acknowledge leaves a three-node cluster that
    # cannot tolerate losing one, which is the whole point of it
    assert has(errors({"patroni-synchronous-node-count": 3}),
               r":patroni-synchronous-node-count must be between 1 and 2")
    assert has(errors({"patroni-synchronous-node-count": 0}),
               r":patroni-synchronous-node-count")
    # two is defensible — a stricter durability bar the cluster can still
    # degrade from — so it is allowed rather than legislated against
    assert errors({"patroni-synchronous-node-count": 2}) == []
    # a TTL that can expire between two health checks is a cluster that fails
    # over because nothing went wrong
    assert has(errors({"patroni-ttl": 15, "patroni-loop-wait": 10}),
               r":patroni-ttl must exceed twice :patroni-loop-wait")


def test_the_endpoint_must_be_reachable_as_postgresql():
    assert has(errors({"cloudflare-proxied": True}),
               r"Cloudflare's proxy does not carry the PostgreSQL wire protocol")
    assert has(errors({"cluster-host": "pg-ha.somewhere.else"}),
               r":cluster-host must be inside :cloudflare-zone")
    assert has(errors({"cloudflare-record-ttl": 30}),
               r":cloudflare-record-ttl must be 1 \(automatic\) or between 60 and 86400")


def test_the_client_connect_timeout_is_desired_state_not_folklore():
    # the endpoint resolves to every node, so a client can try an address
    # whose machine is powered off — which black-holes rather than refuses,
    # and without a bound libpq waits out the OS TCP retry
    assert has(errors({"client-connect-timeout-seconds": 0}),
               r":client-connect-timeout-seconds must be between 1 and 30")
    assert has(errors({"client-connect-timeout-seconds": 120}),
               r":client-connect-timeout-seconds must be between 1 and 30")
    assert has(errors({"client-connect-timeout-seconds": None}),
               r":client-connect-timeout-seconds")
    assert errors({"client-connect-timeout-seconds": 5}) == []


def test_ingress_stays_scoped():
    # The list and CIDR checks are ONCE's, with its messages; the refusal of
    # the world is this package's own and holds however the list is spelled.
    for key in ["digitalocean-ssh-sources", "digitalocean-client-sources"]:
        assert errors({key: ["0.0.0.0/0"]}) == \
            [f":{key} must not contain 0.0.0.0/0; administrative and database ingress stay scoped"]
        assert has(errors({key: "203.0.113.10/32, 0.0.0.0/0"}), r"must not contain 0\.0\.0\.0/0")
        assert errors({key: []}) == [f":{key} must list at least one CIDR"]
        assert errors({key: ["203.0.113.10"]}) == \
            [f':{key} entry "203.0.113.10" is not an IPv4 or IPv6 CIDR']
    # a string is a list, the way an overlay carries one
    assert errors({"digitalocean-ssh-sources": "203.0.113.10/32, 198.51.100.0/24"}) == []


def test_blast_radius_is_separated():
    assert has(errors({"backup-r2-bucket": FIXTURE["r2-bucket"]}),
               r"must not be the OpenTofu state bucket")


def test_versions_are_pinned_precisely_enough_to_reproduce():
    assert has(errors({"patroni-package-version": "4.1.5"}),
               r"must be a full Debian package version")
    assert has(errors({"pgbackrest-package-version": "latest"}),
               r"must be a full Debian package version")
    assert has(errors({"etcd-version": "3.5.33"}),
               r":etcd-version must be an exact vX\.Y\.Z")
    assert has(errors({"haproxy-version": "2.8.5"}),
               r":haproxy-version must be a distribution major\.minor")


def test_the_restore_check_tolerance_cannot_be_set_below_what_archiving_allows():
    assert has(errors({"restore-check-max-lag-seconds": 30}),
               r":restore-check-max-lag-seconds must exceed 120")


def test_credentials_are_demanded_by_name():
    # with none set, every one is named once
    messages = validate.secret_errors(FIXTURE)
    assert len(messages) == len(set(messages))
    for par in ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                "COLORS_PAR_R2_ACCESS_KEY_ID", "COLORS_PAR_R2_SECRET_ACCESS_KEY",
                "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID",
                "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY",
                "COLORS_PAR_POSTGRES_ADMIN_PASSWORD",
                "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD"]:
        assert has(messages, par), par
    # and a supplied one stops being demanded
    assert not has(validate.secret_errors({**FIXTURE, "do-token": "t"}),
                   r"COLORS_PAR_DO_TOKEN\b")


def test_no_message_can_contain_a_credential():
    loaded = {**FIXTURE, "do-token": "tok-do", "cloudflare-api-token": "tok-cf",
              "postgres-admin-password": "hunter2",
              "backup-r2-secret-access-key": "sekrit"}
    messages = [*validate.state_errors(loaded), *validate.secret_errors(loaded)]
    for secret in ["tok-do", "tok-cf", "hunter2", "sekrit"]:
        assert not any(secret in m for m in messages), secret
