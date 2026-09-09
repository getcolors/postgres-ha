from blue.runtime import ExecResult
from conftest import FIXTURE_FILE, fixture
from package_postgres_ha_blue import operator


def test_status_command():
    assert (operator.remote_command("status", fixture(), [])
            == ["patronictl", "-c", "/etc/patroni/patroni.yml", "list"])


def test_backup_command():
    assert operator.remote_command("backup", fixture(), []) == ["/usr/local/bin/postgres-ha-backup"]


def test_verify_restore_command():
    assert (operator.remote_command("verify-restore", fixture(), [])
            == ["/usr/local/bin/postgres-ha-restore-check"])


def test_psql_command():
    assert (operator.remote_command("psql", fixture(), ["-c", "SELECT 1"])
            == ["psql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres",
                "-d", "appdb", "-c", "SELECT 1"])


def test_parse_node_flag():
    assert operator.parse_args(["--node", "2"]) == {"ordinal": 2, "extra": []}
    assert operator.parse_args(["-c", "SELECT 1"]) == {"ordinal": 1, "extra": ["-c", "SELECT 1"]}
    assert operator.parse_args(["--node", "3", "--force"]) == {"ordinal": 3, "extra": ["--force"]}


# Green's runner seam is a `with-redefs` on the inherit runner; here it is a
# plain argument, so the dispatched argv is observable without SSH.
def test_run_dispatches_the_quoted_remote_command_through_ssh():
    seen = []

    def runner(args):
        seen.append(args)
        return ExecResult(exit=0, out="", err="")

    result = operator.run(str(FIXTURE_FILE), "status", [], runner, {"COLORS_PAR_PROVIDER_BACKEND": "r2"})
    assert result["blue/exit"] == 0
    assert len(seen) == 1
    assert seen[0][0] == "ssh"
    # the default `--node 1` is the first node: ONCE's alias for index 0
    assert "postgres-ha-fixture-0" in seen[0]
    assert seen[0][-1] == "'patronictl' '-c' '/etc/patroni/patroni.yml' 'list'"


def test_run_rejects_an_out_of_range_node():
    def runner(args):
        return ExecResult(exit=0, out="", err="")

    result = operator.run(str(FIXTURE_FILE), "status", ["--node", "4"], runner, {"COLORS_PAR_PROVIDER_BACKEND": "r2"})
    assert result["blue/exit"] == 2
    assert "--node must be between 1 and 3" in result["blue/err"]
