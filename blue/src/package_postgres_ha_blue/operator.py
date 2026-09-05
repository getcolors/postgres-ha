"""Day-two verbs, dispatched over SSH to a node or straight at the endpoint —
the port of io.github.getcolors.postgres-ha.operator.

These deliberately hold no cluster logic of their own: `status`, `failover`
and `switchover` are `patronictl`, `backup` and `verify-restore` are the same
two scripts the systemd timers run. Anything that reimplemented part of
Patroni here would be a second, untested opinion about the cluster's state
that only runs when a human is watching.

The launcher is a thin dispatcher, so all of this lives in the library where
the test suite reaches it."""

from __future__ import annotations

import os

from blue.cli import load_yaml, read_pars
from blue.process import posix_quote, run_inherit

from . import tools, utils, validate

KINDS = ("status", "failover", "switchover", "backup", "verify-restore", "psql")

USAGE = (
    "Usage: blue <status|failover|switchover|backup|verify-restore|psql> "
    "[--node N] [-f|--file colors.yml] [-- extra args]\n"
    "\n"
    "  status          patronictl list — members, roles, replication lag\n"
    "  switchover      planned handover to a healthy standby\n"
    "  failover        unplanned promotion; use when the leader is gone\n"
    "  backup          run the pgBackRest full backup now, on the leader\n"
    "  verify-restore  run the verified restore now, on a standby\n"
    "  psql            psql against <cluster-host> through the primary port\n"
    "\n"
    "  --node N        which node to dispatch through (default 1); pick a\n"
    "                  live one when the cluster is degraded")


def _patronictl(*args: str) -> list[str]:
    return ["patronictl", "-c", "/etc/patroni/patroni.yml", *args]


def remote_command(kind: str, opts: dict, extra: list[str]) -> list[str]:
    """The argv run on the node, before quoting.

    `psql` goes through the node's own HAProxy loopback bind rather than
    straight at the local PostgreSQL: the node the operator happened to pick
    may be a standby, and a read-only session that looks like a primary
    session is the worst possible answer to `blue psql`. It also means the
    password is typed at psql's prompt instead of being placed in an argv,
    where `ps` would show it to every user on the machine."""
    if kind == "status":
        return _patronictl("list")
    if kind == "switchover":
        return [*_patronictl("switchover", "--force"), *extra]
    if kind == "failover":
        return [*_patronictl("failover", "--force"), *extra]
    if kind == "backup":
        return ["/usr/local/bin/postgres-ha-backup"]
    if kind == "verify-restore":
        return ["/usr/local/bin/postgres-ha-restore-check"]
    if kind == "psql":
        return ["psql", "-h", "127.0.0.1",
                "-p", str(opts.get("haproxy-primary-port")),
                "-U", str(opts.get("postgres-admin-user")),
                "-d", str(opts.get("postgres-database")),
                *extra]
    return []


def ssh_command(opts: dict, ordinal: int, remote: list[str], tty: bool) -> list[str]:
    """Dispatch through the `~/.ssh/config` alias the local stage manages, so
    the identity file, user and host-key policy are configured in exactly one
    place and this never grows its own copy of them."""
    return ["ssh", "-F", os.path.join(os.path.expanduser("~"), ".ssh/config"),
            *(["-t"] if tty else []),
            "--", tools.ssh_alias(opts, ordinal),
            " ".join(posix_quote(part) for part in remote)]


def command(kind: str, opts: dict, ordinal: int, extra: list[str]) -> list[str]:
    return ssh_command(opts, ordinal, remote_command(kind, opts, extra), kind == "psql")


def parse_args(args: list[str]) -> dict:
    """Split `--node N` out of the argument vector; everything after `--`,
    and anything left over, is forwarded to the underlying tool."""
    remaining = list(args)
    ordinal = 1
    extra: list[str] = []
    while True:
        if not remaining:
            return {"ordinal": ordinal, "extra": extra}
        if remaining[0] == "--":
            return {"ordinal": ordinal, "extra": [*extra, *remaining[1:]]}
        if remaining[0] == "--node":
            value = str(remaining[1]) if len(remaining) > 1 else ""
            try:
                ordinal = int(value)
            except ValueError:
                return {"error": "--node needs an integer node ordinal"}
            remaining = remaining[2:]
            continue
        extra = [*extra, remaining[0]]
        remaining = remaining[1:]


def inherit_run(argv: list[str]):
    return run_inherit(argv)


def run(state_file: str, kind: str, args: list[str],
        runner=None, env: dict | None = None) -> dict:
    invoke = inherit_run if runner is None else runner
    environment = dict(os.environ) if env is None else env
    try:
        if kind not in KINDS:
            return {"blue/exit": 2, "blue/err": USAGE}
        if not os.path.exists(state_file):
            return {"blue/exit": 2,
                    "blue/err": f"desired state file not found: {state_file}"}
        with open(state_file) as f:
            opts = read_pars({
                **load_yaml(f.read()),
                "blue/state-file": os.path.abspath(state_file),
            }, environment)
        parsed = parse_args(args)
        ordinal = parsed.get("ordinal")
        extra = parsed.get("extra")
        error = parsed.get("error")
        errors = [
            *(validate.env_errors(environment) or []),
            *validate.state_errors(opts),
            *([error] if error else []),
            *([f"--node must be between 1 and {utils.NODE_COUNT}"]
              if ordinal is not None and not (1 <= ordinal <= utils.NODE_COUNT)
              else []),
        ]
        if errors:
            return {"blue/exit": 2, "blue/err": "\n".join(errors)}
        result = invoke(command(kind, opts, ordinal, extra))
        exit_code = result.exit
        outcome = {"blue/exit": 0 if exit_code == 0 else max(1, exit_code)}
        if exit_code != 0 and result.err:
            outcome["blue/err"] = result.err
        return outcome
    except Exception as t:
        return {"blue/exit": 2, "blue/err": str(t) or type(t).__name__}
