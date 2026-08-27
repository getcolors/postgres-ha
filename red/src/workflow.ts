// The lifecycle graph, the preflight, and the per-stage remote-state advice —
// the port of io.github.getcolors.postgres-ha.workflow.
//
// Create is strictly sequential. The stages are not independent: DNS needs the
// addresses compute produced, the cluster play needs the inventory those
// addresses build, and acceptance needs a converged cluster *and* a resolvable
// name. Fanning any of it out would only buy back the seconds that DigitalOcean
// spends creating three droplets in one `apply` anyway.
//
// Delete runs the same edges backwards, with one addition: it loads the node
// addresses out of remote state first, because the local SSH configuration it
// has to withdraw is keyed by them and by then the droplets may already be
// gone.

import { parName, readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, workflow, type Opts, type WireDecl } from "red/workflow";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": "digitalocean",
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

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      // Credentials are only demanded by a run that will actually use them.
      // `build` and `--dry-run` therefore work on a fresh checkout with an
      // empty environment, which is what makes them a safe way to review a
      // colors.yml edit.
      (current, _environment, { event, real }) =>
        real && lifecycleEvents.includes(String(event))
          ? validate.secretErrors(current)
          : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? ["compute destruction is protected; set " +
             `${parName("compute-prevent-destroy")}=false for this one delete`]
          : [],
    ],
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

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile}/${tool}.tfstate`,
  });
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
