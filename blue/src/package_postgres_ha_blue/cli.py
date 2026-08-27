"""CLI entry: the same verbs as the green launcher, with the logic kept here
where the test suite reaches it — the copied payload holds none of its own."""

from __future__ import annotations

import asyncio
import sys

from blue.cli import find_up, run_cli

from . import operator
from .workflow import postgres_ha_workflow

USAGE = ("Usage: blue <command> [-f|--file colors.yml] [--dry-run]\n"
         "\n"
         "  build           render the work directory only — contact nothing\n"
         "  create          converge three nodes, replication, backups and DNS\n"
         "  delete          tear the cluster and its infrastructure down\n"
         "\n"
         "  status          patronictl list — members, roles, replication lag\n"
         "  switchover      planned handover to a healthy standby\n"
         "  failover        unplanned promotion; use when the leader is gone\n"
         "  backup          run the pgBackRest full backup now, on the leader\n"
         "  verify-restore  run the verified restore now, on a standby\n"
         "  psql            psql against the current primary through HAProxy\n"
         "\n"
         "  --node N        which node an operator verb dispatches through\n"
         "                  (default 1); pick a live one when degraded")

LIFECYCLE = ("build", "create", "delete")
OPERATOR = ("status", "switchover", "failover", "backup", "verify-restore", "psql")


def _find() -> str:
    return find_up("colors.yml") or "colors.yml"


def default_args(args: list[str]) -> list[str]:
    if any(a in ("-f", "--file") or str(a).startswith("--file=") for a in args):
        return args
    return [*args, "-f", _find()]


def state_file(args: list[str]) -> str:
    """The desired-state path for an operator verb, whose arguments are the
    underlying tool's rather than blue's."""
    for i, arg in enumerate(args):
        if arg in ("-f", "--file") and i + 1 < len(args):
            return args[i + 1]
    for arg in args:
        if str(arg).startswith("--file="):
            return str(arg)[len("--file="):]
    return _find()


def without_file_args(args: list[str]) -> list[str]:
    kept: list[str] = []
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg in ("-f", "--file"):
            skip = True
            continue
        if str(arg).startswith("--file="):
            continue
        kept.append(arg)
    return kept


async def run(*args):
    """REPL-friendly entry point that returns the final outcome map."""
    args = list(args)
    command = args[0] if args else None
    if command in ("help", "--help", "-h"):
        return {"blue/exit": 0, "blue/err": USAGE}
    if command in LIFECYCLE:
        return await run_cli(postgres_ha_workflow, default_args(args))
    if command in OPERATOR:
        return operator.run(state_file(args), command, without_file_args(args)[1:])
    return {"blue/exit": 2, "blue/err": USAGE}


def exec(args: list[str] | None = None) -> None:
    result = asyncio.run(run(*(sys.argv[1:] if args is None else args)))
    if result.get("blue/err"):
        stream = sys.stdout if (result.get("blue/exit") or 0) == 0 else sys.stderr
        print(result["blue/err"], file=stream)
        if result.get("blue/trace"):
            print(result["blue/trace"], file=stream)
    raise SystemExit(result.get("blue/exit") or 0)
