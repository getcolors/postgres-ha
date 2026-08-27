// CLI entry: the same verbs as the green launcher, with the logic kept here
// where the test suite reaches it — the copied payload holds none of its own.

import { execCli, findUp, runCli } from "red/cli";
import type { Opts } from "red/workflow";
import * as operator from "./operator.ts";
import { postgresHaWorkflow } from "./workflow.ts";

export const lifecycleCommands = ["build", "create", "delete"];

export const operatorCommands: Record<string, string> = {
  status: "status",
  switchover: "switchover",
  failover: "failover",
  backup: "backup",
  "verify-restore": "verify-restore",
  psql: "psql",
};

export const usage =
  "Usage: red <command> [-f|--file colors.yml] [--dry-run]\n" +
  "\n" +
  "  build           render the work directory only — contact nothing\n" +
  "  create          converge three nodes, replication, backups and DNS\n" +
  "  delete          tear the cluster and its infrastructure down\n" +
  "\n" +
  "  status          patronictl list — members, roles, replication lag\n" +
  "  switchover      planned handover to a healthy standby\n" +
  "  failover        unplanned promotion; use when the leader is gone\n" +
  "  backup          run the pgBackRest full backup now, on the leader\n" +
  "  verify-restore  run the verified restore now, on a standby\n" +
  "  psql            psql against the current primary through HAProxy\n" +
  "\n" +
  "  --node N        which node an operator verb dispatches through\n" +
  "                  (default 1); pick a live one when degraded";

// The nearest colors.yml at or above the working directory. Walking up means
// red can be run from any subdirectory of a project and still find the one
// desired state.
function defaultFile(): string {
  return findUp("colors.yml") ?? "colors.yml";
}

function fileArg(arg: string): boolean {
  return arg === "-f" || arg === "--file" || arg.startsWith("--file=");
}

export function defaultArgs(args: string[]): string[] {
  return args.some(fileArg) ? args : [...args, "-f", defaultFile()];
}

// The desired-state path for an operator verb, whose arguments are the
// underlying tool's rather than red's.
export function stateFile(args: string[]): string {
  const flagIndex = args.findIndex((arg) => arg === "-f" || arg === "--file");
  if (flagIndex >= 0 && args[flagIndex + 1] !== undefined) return args[flagIndex + 1]!;
  const inline = args.find((arg) => arg.startsWith("--file="));
  if (inline !== undefined) return inline.slice("--file=".length);
  return defaultFile();
}

export function withoutFileArgs(args: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-f" || arg === "--file") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--file=")) continue;
    kept.push(arg);
  }
  return kept;
}

// REPL-friendly entry point that returns the final outcome map.
export async function run(...args: string[]): Promise<Opts> {
  const command = args[0] ?? "";
  if (["help", "--help", "-h"].includes(command)) {
    return { "red/exit": 0, "red/err": usage };
  }
  if (lifecycleCommands.includes(command)) {
    return runCli(postgresHaWorkflow, defaultArgs(args));
  }
  if (command in operatorCommands) {
    return operator.run(stateFile(args), operatorCommands[command]!,
                        withoutFileArgs(args).slice(1));
  }
  return { "red/exit": 2, "red/err": usage };
}

export async function exec(args: string[] = Bun.argv.slice(2)): Promise<never> {
  if (lifecycleCommands.includes(args[0] ?? "")) {
    return execCli(postgresHaWorkflow, defaultArgs(args));
  }
  const result = await run(...args);
  if (result["red/err"]) {
    ((result["red/exit"] ?? 0) === 0 ? console.log : console.error)(result["red/err"]);
  }
  return process.exit(result["red/exit"] ?? 0);
}
