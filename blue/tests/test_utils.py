import re

from package_postgres_ha_blue import utils

OPTS = {"profile": "pg", "digitalocean-name": "postgres-ha"}


def test_topology_is_derived_not_configured():
    assert utils.ordinals() == [1, 2, 3]
    assert utils.NODE_COUNT == 3
    assert [utils.node_name(OPTS, n) for n in utils.ordinals()] == \
        ["postgres-ha-1", "postgres-ha-2", "postgres-ha-3"]


def test_names_fall_back_rather_than_rendering_nil():
    # a half-populated desired state still renders reviewable names
    assert utils.node_name({}, 1) == "postgres-ha-1"
    assert utils.node_name({"digitalocean-name": ""}, 1) == "postgres-ha-1"


def test_par_lookup_names_the_shared_credential_namespace():
    assert utils.par_lookup("postgres-admin-password") == \
        "{{ lookup('env','COLORS_PAR_POSTGRES_ADMIN_PASSWORD') }}"
    # it renders the expression, never a value
    assert not re.search(r"secret|password=",
                         utils.par_lookup("backup-r2-secret-access-key"))


def test_endpoint_host_strips_what_pgbackrest_will_not_take():
    # pgBackRest wants a bare host, and an https:// prefix makes it fail with
    # a DNS error that names a host containing a slash
    assert utils.endpoint_host("https://account.r2.cloudflarestorage.com") == \
        "account.r2.cloudflarestorage.com"
    assert utils.endpoint_host("https://account.r2.cloudflarestorage.com/") == \
        "account.r2.cloudflarestorage.com"
    assert utils.endpoint_host("account.r2.cloudflarestorage.com") == \
        "account.r2.cloudflarestorage.com"


def test_repo_path_is_absolute_inside_the_bucket():
    assert utils.repo_path("postgres-ha-digitalocean") == "/postgres-ha-digitalocean"
    assert utils.repo_path("/postgres-ha-digitalocean") == "/postgres-ha-digitalocean"
    assert utils.repo_path("") == "/"
