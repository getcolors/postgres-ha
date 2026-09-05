// Day-two verbs, dispatched over SSH to a node or straight at the endpoint —
// the port of io.github.getcolors.postgres-ha.operator.
//
// These deliberately hold no cluster logic of their own: `status`, `failover`
// and `switchover` are `patronictl`, `backup` and `verify-restore` are the
// same two scripts the systemd timers run. Anything that reimplemented part of
// Patroni here would be a second, untested opinion about the cluster's state
// that only runs when a human is watching.
//
// The launcher is a thin dispatcher, so all of this lives in the library where
// the test suite reaches it.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readPars } from "red/cli";
import { posixQuote, runInherit } from "red/process";
import type { Opts } from "red/workflow";
import * as tools from "./tools.ts";
import * as utils from "./utils.ts";
import * as validate from "./validate.ts";

export const kinds = ["status", "failover", "switchover", "backup",
                      "verify-restore", "psql"];

export const usage =
  "Usage: red <status|failover|switchover|backup|verify-restore|psql> " +
  "[--node N] [-f|--file colors.yml] [-- extra args]\n" +
  "\n" +
  "  status          patronictl list — members, roles, replication lag\n" +
  "  switchover      planned handover to a healthy standby\n" +
  "  failover        unplanned promotion; use when the leader is gone\n" +
  "  backup          run the pgBackRest full backup now, on the leader\n" +
  "  verify-restore  run the verified restore now, on a standby\n" +
  "  psql            psql against <cluster-host> through the primary port\n" +
  "\n" +
  "  --node N        which node to dispatch through (default 1); pick a\n" +
  "                  live one when the cluster is degraded";

function patronictl(...args: string[]): string[] {
  return ["patronictl", "-c", "/etc/patroni/patroni.yml", ...args];
}

// The argv run on the node, before quoting.
//
// `psql` goes through the node's own HAProxy loopback bind rather than
// straight at the local PostgreSQL: the node the operator happened to pick may
// be a standby, and a read-only session that looks like a primary session is
// the worst possible answer to `red psql`. It also means the password is
// typed at psql's prompt instead of being placed in an argv, where `ps` would
// show it to every user on the machine.
export function remoteCommand(kind: string, opts: Opts, extra: string[]): string[] {
  switch (kind) {
    case "status": return patronictl("list");
    case "switchover": return [...patronictl("switchover", "--force"), ...extra];
    case "failover": return [...patronictl("failover", "--force"), ...extra];
    case "backup": return ["/usr/local/bin/postgres-ha-backup"];
    case "verify-restore": return ["/usr/local/bin/postgres-ha-restore-check"];
    case "psql": return [
      "psql", "-h", "127.0.0.1",
      "-p", String(opts["haproxy-primary-port"]),
      "-U", String(opts["postgres-admin-user"]),
      "-d", String(opts["postgres-database"]),
      ...extra,
    ];
    default: return [];
  }
}

// Dispatch through the `~/.ssh/config` alias the local stage manages, so the
// identity file, user and host-key policy are configured in exactly one place
// and this never grows its own copy of them.
export function sshCommand(opts: Opts, ordinal: number, remote: string[], tty: boolean): string[] {
  return [
    "ssh", "-F", join(homedir(), ".ssh/config"),
    ...(tty ? ["-t"] : []),
    "--", tools.sshAlias(opts, ordinal),
    remote.map(posixQuote).join(" "),
  ];
}

export function command(kind: string, opts: Opts, ordinal: number, extra: string[]): string[] {
  return sshCommand(opts, ordinal, remoteCommand(kind, opts, extra), kind === "psql");
}

export interface ParsedArgs { ordinal?: number; extra?: string[]; error?: string }

// Split `--node N` out of the argument vector; everything after `--`, and
// anything left over, is forwarded to the underlying tool.
export function parseArgs(args: string[]): ParsedArgs {
  let remaining = [...args];
  let ordinal = 1;
  let extra: string[] = [];
  for (;;) {
    if (remaining.length === 0) return { ordinal, extra };
    if (remaining[0] === "--") {
      return { ordinal, extra: [...extra, ...remaining.slice(1)] };
    }
    if (remaining[0] === "--node") {
      const n = Number(remaining[1]);
      if (!Number.isInteger(n) || !/^-?\d+$/.test(String(remaining[1]))) {
        return { error: "--node needs an integer node ordinal" };
      }
      ordinal = n;
      remaining = remaining.slice(2);
      continue;
    }
    extra = [...extra, remaining[0]!];
    remaining = remaining.slice(1);
  }
}

export type Runner = (argv: string[]) => Promise<{ exit: number; err?: string }> | { exit: number; err?: string };

export const inheritRun: Runner = (argv) => runInherit(argv);

export async function run(
  stateFile: string,
  kind: string,
  args: string[],
  runner: Runner = inheritRun,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  try {
    if (!kinds.includes(kind)) return { "red/exit": 2, "red/err": usage };
    if (!existsSync(stateFile)) {
      return { "red/exit": 2, "red/err": `desired state file not found: ${stateFile}` };
    }
    const opts = readPars({
      ...((Bun.YAML.parse(readFileSync(stateFile, "utf8")) ?? {}) as Opts),
      "red/state-file": resolve(stateFile),
    }, env);
    const { ordinal, extra, error } = parseArgs(args);
    const errors = [
      ...(validate.envErrors(env) ?? []),
      ...validate.stateErrors(opts),
      ...(error ? [error] : []),
      ...(ordinal !== undefined && !(1 <= ordinal && ordinal <= utils.nodeCount)
        ? [`--node must be between 1 and ${utils.nodeCount}`]
        : []),
    ];
    if (errors.length) return { "red/exit": 2, "red/err": errors.join("\n") };
    const result = await runner(command(kind, opts, ordinal!, extra!));
    const outcome: Opts = { "red/exit": result.exit === 0 ? 0 : Math.max(1, result.exit) };
    if (result.exit !== 0 && result.err) outcome["red/err"] = result.err;
    return outcome;
  } catch (t) {
    return {
      "red/exit": 2,
      "red/err": t instanceof Error ? t.message || t.constructor.name : String(t),
    };
  }
}
