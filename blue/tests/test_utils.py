from package_postgres_ha_blue import utils


def test_launcher_contract_version():
    assert isinstance(utils.CONTRACT, int) and utils.CONTRACT > 0


def test_node_count_and_ordinals():
    assert utils.NODE_COUNT == 3
    assert utils.ordinals() == [1, 2, 3]




def test_par_lookup_formatting():
    assert (utils.par_lookup("postgres-admin-password")
            == "{{ lookup('env','COLORS_PAR_POSTGRES_ADMIN_PASSWORD') }}")
    assert utils.par_lookup("do-token") == "{{ lookup('env','COLORS_PAR_DO_TOKEN') }}"


def test_endpoint_host_extraction():
    assert (utils.endpoint_host("https://319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com")
            == "319271fed8bc6d2d9059362be1165f37.eu.r2.cloudflarestorage.com")
    assert utils.endpoint_host("http://s3.amazonaws.com/") == "s3.amazonaws.com"


def test_repo_path_extraction():
    assert utils.repo_path("postgres-ha-digitalocean") == "/postgres-ha-digitalocean"
    assert utils.repo_path("/my/path") == "/my/path"
    assert utils.repo_path("") == "/"
