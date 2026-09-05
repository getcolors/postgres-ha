from pathlib import Path

from blue.cli import par_name
from blue.runtime import ExecResult
from package_postgres_ha_blue import operator

from conftest import ROOT, fixture

STATE_FILE = str(ROOT / "test" / "fixtures" / "colors.yml")
FIXTURE = fixture()


def capture():
    box = {"seen": None}

    def runner(argv):
        box["seen"] = argv
        return ExecResult(0, "", "")

    return box, runner


def test_node_selection_is_explicit_and_bounded():
    assert operator.parse_args([]) == {"ordinal": 1, "extra": []}
    assert operator.parse_args(["--node", "2"]) == {"ordinal": 2, "extra": []}
    assert operator.parse_args(["--node", "3", "--candidate", "x"]) == \
        {"ordinal": 3, "extra": ["--candidate", "x"]}
    assert operator.parse_args(["--", "--candidate", "x"]) == \
        {"ordinal": 1, "extra": ["--candidate", "x"]}
    assert operator.parse_args(["--node", "second"]).get("error")


def test_out_of_range_nodes_are_refused_before_anything_is_dispatched():
    box, runner = capture()
    result = operator.run(STATE_FILE, "status", ["--node", "9"], runner, {})
    assert result["blue/exit"] == 2
    assert "--node must be between 1 and 3" in result["blue/err"]
    # a refused invocation must not reach a host
    assert box["seen"] is None


def test_operator_verbs_dispatch_through_the_managed_ssh_alias():
    # so the identity file and host-key policy are defined once, by the local
    # stage, rather than copied into every verb
    argv = operator.command("status", FIXTURE, 2, [])
    assert argv[0] == "ssh"
    assert any(str(a).endswith(".ssh/config") for a in argv)
    # `--node 2` is the second node: ONCE's alias for index 1
    assert any(a == "postgres-ha-fixture-1" for a in argv)
    assert "patronictl" in argv[-1]


def test_the_verbs_are_the_tools_not_a_second_opinion_about_the_cluster():
    assert operator.remote_command("status", FIXTURE, []) == \
        ["patronictl", "-c", "/etc/patroni/patroni.yml", "list"]
    assert operator.remote_command("failover", FIXTURE, []) == \
        ["patronictl", "-c", "/etc/patroni/patroni.yml", "failover", "--force"]
    assert operator.remote_command(
        "switchover", FIXTURE, ["--candidate", "postgres-ha-fixture-3"]) == \
        ["patronictl", "-c", "/etc/patroni/patroni.yml", "switchover", "--force",
         "--candidate", "postgres-ha-fixture-3"]
    # backup and verify-restore run exactly what the timers run, so a manual
    # run cannot pass while the scheduled one is broken
    assert operator.remote_command("backup", FIXTURE, []) == \
        ["/usr/local/bin/postgres-ha-backup"]
    assert operator.remote_command("verify-restore", FIXTURE, []) == \
        ["/usr/local/bin/postgres-ha-restore-check"]


def test_psql_goes_through_haproxy_and_never_carries_the_password_in_argv():
    remote = operator.remote_command("psql", FIXTURE, [])
    argv = operator.command("psql", FIXTURE, 1, [])
    assert remote == ["psql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres",
                      "-d", "appdb"]
    # loopback HAProxy, not the local PostgreSQL: the node the operator picked
    # may be a standby, and a read-only session that looks like a primary
    # session is the worst possible answer
    assert remote[2] == "127.0.0.1"
    # psql needs a terminal for its password prompt
    assert any(a == "-t" for a in argv)
    assert not any("PGPASSWORD" in str(a) for a in argv)


def test_the_profile_overlay_is_refused_here_too():
    box, runner = capture()
    result = operator.run(STATE_FILE, "status", [], runner,
                          {par_name("profile"): "elsewhere"})
    assert result["blue/exit"] == 2
    assert box["seen"] is None


def test_an_unknown_verb_prints_usage_rather_than_guessing():
    box, runner = capture()
    result = operator.run(STATE_FILE, "restart", [], runner, {})
    assert result["blue/exit"] == 2
    assert "Usage:" in result["blue/err"]
    assert box["seen"] is None


def test_a_missing_desired_state_file_is_a_usage_error():
    result = operator.run(str(Path(STATE_FILE).parent / "absent.yml"),
                          "status", [], capture()[1], {})
    assert result["blue/exit"] == 2


def test_a_failing_command_propagates_a_nonzero_exit():
    result = operator.run(STATE_FILE, "status", [],
                          lambda _argv: ExecResult(3, "", "boom"), {})
    assert result["blue/exit"] == 3
