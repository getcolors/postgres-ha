// The lifecycle graph, the preflight, and the per-stage remote-state advice —
// the port of io.github.getcolors.postgres-ha.workflow.
//
// Create is strictly sequential. The stages are not independent: DNS needs the
// addresses compute produced, the cluster play needs the inventory those
// addresses build, and acceptance needs a converged cluster *and* a resolvable
// name. Fanning any of it out would only buy back the seconds that DigitalOcean
// spends creating three droplets in one `apply` anyway.
//
// Delete runs the same edges backwards, with one addition: it adopts the
// cluster out of remote state first, because the local SSH configuration it
// has to withdraw is keyed by the nodes and by then the droplets may already
// be gone. The state is read once, in preflight, so the Compute Provider
// Standard's switch guard runs before the credentials are checked; the read is
// handed to `load-infrastructure` rather than repeated.

import { parName, readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import { adviceAdd, workflow, type Opts, type WireDecl } from "red/workflow";
import { compute, computeCluster } from "package-once-red";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": validate.defaultComputeProvider,
  "provider-dns": "cloudflare",
  "provider-backend": "local",
  "compute-prevent-destroy": true,
  workdir: ".colors",
  "cluster-nodes": 3,
  "cloudflare-proxied": false,
  "cloudflare-record-ttl": 60,
  "digitalocean-vpc-mode": "default",
  "postgres-port": 5432,
  "postgres-admin-user": "postgres",
  "postgres-replication-user": "replicator",
  "patroni-rest-port": 8008,
  "patroni-ttl": 30,
  "patroni-loop-wait": 10,
  "patroni-retry-timeout": 10,
  "patroni-synchronous-node-count": 1,
  "etcd-client-port": 2379,
  "etcd-peer-port": 2380,
  "haproxy-primary-port": 5432,
  "haproxy-replica-port": 5433,
  "haproxy-stats-port": 7000,
  "client-connect-timeout-seconds": 5,
  "backup-stanza": "main",
  "backup-retention-full": 4,
  "backup-r2-region": "auto",
  "restore-check-port": 5442,
  "restore-check-max-age-hours": 26,
  "restore-check-max-lag-seconds": 900,
  "heartbeat-oncalendar": "*:0/1",
  "heartbeat-retention-days": 7,
};

export const lifecycleEvents = ["create", "delete"];

const realLifecycleEvent = ({ event, real }: PreflightContext): boolean =>
  real && lifecycleEvents.includes(String(event));

// Preflight. On a real create or delete the compute state is read once through
// `reader` — the package's `tools.stateOutput` unless a test injects another —
// on the same defaulted and overlaid opts the validators see, and only once
// desired state itself has passed, so the reader never renders an invalid
// colors.yml. The read feeds the switch guard here and travels on under
// `postgres-ha/state` for `load-infrastructure` to adopt.
//
// Credentials are only demanded by a run that will actually use them. `build`
// and `--dry-run` therefore work on a fresh checkout with an empty
// environment, which is what makes them a safe way to review a colors.yml
// edit.
export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
  reader: compute.StateReader = tools.stateOutput,
): Promise<Opts> {
  const overlaid = readPars({ ...defaults, ...opts }, env);
  const context: PreflightContext = {
    event: typeof overlaid["red/event"] === "string" ? overlaid["red/event"] as string : undefined,
    real: !overlaid["red/dry-run"],
  };
  const state: compute.StateRead =
    realLifecycleEvent(context)
      && (validate.envErrors(env) ?? []).length === 0
      && validate.stateErrors(overlaid).length === 0
      ? await computeCluster.readState(overlaid, reader)
      : {};
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      // Standard §4 before the credentials: a recorded provider that differs
      // from the selected one reports the actionable error, not a missing
      // token for the provider that was just selected.
      (current, _environment, ctx) => (realLifecycleEvent(ctx)
        ? computeCluster.providerValidator(validate.spec, current, state.params, () => validate.secretErrors(current))
        : []),
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? ["compute destruction is protected; set " +
             `${parName("compute-prevent-destroy")}=false for this one delete`]
          : [],
    ],
    afterValidate: (current, _environment, ctx) => (realLifecycleEvent(ctx)
      ? { ...current, "red/exit": 0, "postgres-ha/state": state }
      : { ...current, "red/exit": 0 }),
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "postgres-ha/start": [startStep, "postgres-ha/load-infrastructure"],
      "postgres-ha/load-infrastructure": [tools.loadInfrastructureStep,
                                          "postgres-ha/cluster"],
      "postgres-ha/cluster": [tools.clusterStep, "postgres-ha/ansible-local"],
      "postgres-ha/ansible-local": [tools.ansibleLocalStep, "postgres-ha/dns"],
      "postgres-ha/dns": [tools.dnsStep, "postgres-ha/infrastructure"],
      "postgres-ha/infrastructure": [tools.infrastructureStep,
                                     "postgres-ha/generated-cleanup"],
      "postgres-ha/generated-cleanup": [tools.generatedCleanupStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "postgres-ha/start": [startStep, "postgres-ha/infrastructure"],
    "postgres-ha/infrastructure": [tools.infrastructureStep, "postgres-ha/dns"],
    "postgres-ha/dns": [tools.dnsStep, "postgres-ha/ansible-local"],
    "postgres-ha/ansible-local": [tools.ansibleLocalStep, "postgres-ha/cluster"],
    "postgres-ha/cluster": [tools.clusterStep, "postgres-ha/acceptance"],
    "postgres-ha/acceptance": [tools.acceptanceStep],
  };
  return graph[step];
}

// The state backend of one OpenTofu stage: `tools.backendAdvice`, which the
// state reader also runs, so a delete from a fresh clone finds its state.
export function backendAdvice(tool: string) {
  return tools.backendAdvice(tool);
}

export const sideEffectingSteps = [
  "postgres-ha/load-infrastructure", "postgres-ha/infrastructure",
  "postgres-ha/dns", "postgres-ha/ansible-local", "postgres-ha/cluster",
  "postgres-ha/acceptance", "postgres-ha/generated-cleanup",
];

function create() {
  let wf = workflow({ start: "postgres-ha/start", wireFn });
  wf = adviceAdd(wf, "postgres-ha/load-infrastructure", "before",
                 "io.github.getcolors.postgres-ha.workflow/backend",
                 backendAdvice(tools.infrastructureTool));
  wf = adviceAdd(wf, "postgres-ha/infrastructure", "before",
                 "io.github.getcolors.postgres-ha.workflow/backend",
                 backendAdvice(tools.infrastructureTool));
  wf = adviceAdd(wf, "postgres-ha/dns", "before",
                 "io.github.getcolors.postgres-ha.workflow/backend",
                 backendAdvice(tools.dnsTool));
  wf = progress.advise(wf);
  wf = dryRun.advise(wf, sideEffectingSteps);
  return wf;
}

export const postgresHaWorkflow = create();
