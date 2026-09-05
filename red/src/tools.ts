// The five stages: DigitalOcean infrastructure, Cloudflare DNS, local SSH
// configuration, the remote cluster convergence, and acceptance — the port of
// io.github.getcolors.postgres-ha.tools.
//
// Every stage renders into `.colors/<profile>/<stage>/` and, for the OpenTofu
// ones, keys its remote state at `<profile>/<stage>.tfstate`. Those two names
// are the deployment's identity; changing either orphans live infrastructure,
// so they are constants here and asserted by the golden suite.
//
// The cluster itself — which machines exist, at which addresses — is the
// Compute Cluster Standard's `params`, adopted through ONCE's `computeCluster`
// module and carried under `once/cluster`. This package puts its own facts
// inside it: `vpc_id` and `vpc_ip_range` at the top level.

import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { toolEnv } from "red/providers";
import { runtime } from "red/runtime";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import { compute, computeCluster } from "package-once-red";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as utils from "./utils.ts";
import * as validate from "./validate.ts";

import acceptanceSh from "../resources/tools/acceptance/acceptance.sh" with { type: "text" };
import ansibleLocalCfg from "../resources/tools/ansible-local/ansible.cfg" with { type: "text" };
import ansibleLocalInventory from "../resources/tools/ansible-local/inventory.ini" with { type: "text" };
import ansibleLocalMain from "../resources/tools/ansible-local/main.yml" with { type: "text" };
import ansibleRemoteCfg from "../resources/tools/ansible-remote/ansible.cfg" with { type: "text" };
import ansibleRemoteCleanup from "../resources/tools/ansible-remote/cleanup.yml" with { type: "text" };
import ansibleRemoteMain from "../resources/tools/ansible-remote/main.yml" with { type: "text" };
import etcdConf from "../resources/tools/ansible-remote/etcd.conf.yml.j2" with { type: "text" };
import etcdService from "../resources/tools/ansible-remote/etcd.service.j2" with { type: "text" };
import haproxyCfg from "../resources/tools/ansible-remote/haproxy.cfg.j2" with { type: "text" };
import patroniService from "../resources/tools/ansible-remote/patroni.service.j2" with { type: "text" };
import patroniYml from "../resources/tools/ansible-remote/patroni.yml.j2" with { type: "text" };
import pgbackrestConf from "../resources/tools/ansible-remote/pgbackrest.conf.j2" with { type: "text" };
import backupScript from "../resources/tools/ansible-remote/postgres-ha-backup.j2" with { type: "text" };
import backupService from "../resources/tools/ansible-remote/postgres-ha-backup.service.j2" with { type: "text" };
import backupTimer from "../resources/tools/ansible-remote/postgres-ha-backup.timer.j2" with { type: "text" };
import heartbeatScript from "../resources/tools/ansible-remote/postgres-ha-heartbeat.j2" with { type: "text" };
import heartbeatService from "../resources/tools/ansible-remote/postgres-ha-heartbeat.service.j2" with { type: "text" };
import heartbeatTimer from "../resources/tools/ansible-remote/postgres-ha-heartbeat.timer.j2" with { type: "text" };
import restoreCheckScript from "../resources/tools/ansible-remote/postgres-ha-restore-check.j2" with { type: "text" };
import restoreCheckService from "../resources/tools/ansible-remote/postgres-ha-restore-check.service.j2" with { type: "text" };
import restoreCheckTimer from "../resources/tools/ansible-remote/postgres-ha-restore-check.timer.j2" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureMainTf from "../resources/tools/infrastructure/main.tf" with { type: "text" };

export const infrastructureTool = "postgres-ha-infrastructure";
export const dnsTool = "postgres-ha-dns";
export const ansibleLocalTool = "postgres-ha-ansible-local";
export const clusterTool = "postgres-ha-cluster";
export const acceptanceTool = "postgres-ha-acceptance";
export const tofuTools = [infrastructureTool, dnsTool];

export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "postgres-ha" });
}

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string> = {
  "acceptance/acceptance.sh": acceptanceSh,
  "ansible-local/ansible.cfg": ansibleLocalCfg,
  "ansible-local/inventory.ini": ansibleLocalInventory,
  "ansible-local/main.yml": ansibleLocalMain,
  "ansible-remote/ansible.cfg": ansibleRemoteCfg,
  "ansible-remote/cleanup.yml": ansibleRemoteCleanup,
  "ansible-remote/main.yml": ansibleRemoteMain,
  "ansible-remote/etcd.conf.yml.j2": etcdConf,
  "ansible-remote/etcd.service.j2": etcdService,
  "ansible-remote/haproxy.cfg.j2": haproxyCfg,
  "ansible-remote/patroni.service.j2": patroniService,
  "ansible-remote/patroni.yml.j2": patroniYml,
  "ansible-remote/pgbackrest.conf.j2": pgbackrestConf,
  "ansible-remote/postgres-ha-backup.j2": backupScript,
  "ansible-remote/postgres-ha-backup.service.j2": backupService,
  "ansible-remote/postgres-ha-backup.timer.j2": backupTimer,
  "ansible-remote/postgres-ha-heartbeat.j2": heartbeatScript,
  "ansible-remote/postgres-ha-heartbeat.service.j2": heartbeatService,
  "ansible-remote/postgres-ha-heartbeat.timer.j2": heartbeatTimer,
  "ansible-remote/postgres-ha-restore-check.j2": restoreCheckScript,
  "ansible-remote/postgres-ha-restore-check.service.j2": restoreCheckService,
  "ansible-remote/postgres-ha-restore-check.timer.j2": restoreCheckTimer,
  "dns/main.tf": dnsMainTf,
  "infrastructure/main.tf": infrastructureMainTf,
};

export function template(path: string, file: string): Template {
  const name = `${path.replaceAll(".", "/")}/${file}`;
  const content = templates[name];
  if (content === undefined) throw new StepError(`template not found: ${name}`);
  return { name, content };
}

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  return toolEnv(validate.providers, opts, [...slots, "provider-backend"]);
}

export function backendCredentialEnv(opts: Opts): Record<string, string> | undefined {
  return credentialEnv(opts);
}

// The state backend of one OpenTofu stage, written before the stage runs.
// `dir` and `key` are explicit so the state addresses cannot move.
export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => toolDir(opts, tool),
    key: (opts) => `${opts.profile}/${tool}.tfstate`,
  });
}

function refuse(opts: Opts, errors: string[]): Opts {
  return { ...opts, "red/exit": 1, "red/err": errors.join("\n") };
}

// ---------------------------------------------------------------------------
// Placeholder topology
//
// `build` renders the whole tree without contacting a provider, so it needs
// values that are obviously not real. The nodes are ONCE's fallbacks — RFC
// 5737 TEST-NET-1 public addresses and RFC 1918 private ones cut from `spec`'s
// subnet at offset 11 — and the network facts beside them are the stand-ins
// below. A golden file that leaked into a real run fails loudly rather than
// pointing at somebody's host, and the goldens stay a pure function of
// colors.yml.

export const fallbackOutputs: Opts = {
  vpc_id: "00000000-0000-0000-0000-000000000000",
  vpc_ip_range: "10.114.0.0/20",
};

export interface Node {
  ordinal: number;
  name: string;
  alias: string;
  "public-ip": string;
  "private-ip": string;
}

// ONCE's nodes for this deployment: the adopted `params.nodes` on a real run,
// the fallbacks on a build — renamed to what this package has always called
// its nodes, `<name>-<ordinal>`, so the rendered inventory is byte-identical
// to what it was.
function clusterNodes(opts: Opts): computeCluster.Node[] {
  const params = opts["once/cluster"] as computeCluster.ClusterParams | undefined;
  const members = computeCluster.nodes(validate.spec, opts, params);
  if (params !== undefined && params !== null) return members;
  return members.map((node) => ({ ...node, name: utils.nodeName(opts, node.index + 1) }));
}

// The `~/.ssh/config` Host entry the operator commands use for ordinal `n`:
// ONCE's `<profile>-<index>`, the Compute Cluster Standard's alias for the
// node at 0-based `index`. ONCE's list opens with the bare profile, so the
// 1-based ordinal is also the position of its node's alias.
export function sshAlias(opts: Opts, n: number): string {
  return computeCluster.aliases(validate.spec, opts)[n]!;
}

// The rendered topology: one map per ordinal over the node ONCE reports — the
// adopted cluster on a real run, the placeholders before the infrastructure
// stage has run. Pure: given the same opts it is the same array, which is what
// makes the inventory and the goldens deterministic.
export function nodes(opts: Opts): Node[] {
  return clusterNodes(opts).map((node) => {
    const ordinal = node.index + 1;
    return {
      ordinal,
      name: String(node.name),
      alias: sshAlias(opts, ordinal),
      "public-ip": String(node.ip),
      "private-ip": String(node.vpc_ip),
    };
  });
}

// ---------------------------------------------------------------------------
// Stage 1 — infrastructure

// The compute template's data. The machine-key paths are filled here as well
// as in preflight, so the template renders the same bytes whichever step
// scaffolds it; in keygen mode the template references the key resource and
// the literal list is not rendered.
export function infrastructureData(opts: Opts): Opts {
  opts = ssh.withMachineKey(opts);
  return {
    ...opts,
    "node-names-hcl": tofu.hclList(utils.ordinals().map((n) => utils.nodeName(opts, n))),
    "ssh-keys-hcl": validate.keygen(opts)
      ? "[]"
      : tofu.hclList(compute.cidrs(opts, "digitalocean-ssh-keys")),
    "ssh-sources-hcl": tofu.hclList(compute.cidrs(opts, "digitalocean-ssh-sources")),
    "client-sources-hcl": tofu.hclList(compute.cidrs(opts, "digitalocean-client-sources")),
  };
}

export function infrastructureSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, infrastructureTool);
  return [spec(template("infrastructure", "main.tf"), `${dir}/main.tf`,
               infrastructureData(opts))];
}

// The compute stage's `params` output, as ONCE reads it; undefined when the
// apply reported none.
export function outputParams(result: Opts): computeCluster.ClusterParams | undefined {
  return computeCluster.outputParams({ "tofu/outputs": result["postgres-ha/outputs"] });
}

const nonBlank = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

// The extension keys this package puts inside `params`, which ONCE preserves
// but does not read: a non-blank `vpc_id` and a canonical `vpc_ip_range`, the
// network every etcd, Patroni and firewall rule is scoped to. A real run is
// refused without them; the legacy translation is held to the same rule.
export function paramsErrors(params: computeCluster.ClusterParams): string[] {
  const errors: string[] = [];
  if (!nonBlank(params.vpc_id)) errors.push("compute state carries no vpc_id");
  if (!nonBlank(params.vpc_ip_range)) {
    errors.push("compute state carries no vpc_ip_range");
  } else if (!computeCluster.ipv4Network(params.vpc_ip_range)) {
    errors.push(`compute state vpc_ip_range ${JSON.stringify(params.vpc_ip_range)}`
      + " is not a canonical IPv4 network such as 10.40.0.0/24");
  }
  return errors;
}

// `opts` once the adopted cluster passes `paramsErrors`, or the refusal.
function checked(opts: Opts): Opts {
  const errors = "once/cluster" in opts
    ? paramsErrors(opts["once/cluster"] as computeCluster.ClusterParams) : [];
  return errors.length > 0 ? refuse(opts, errors) : opts;
}

// What the infrastructure stage hands on after its apply: `result` as it is on
// a failure, a delete or a build, and otherwise ONCE's `resolvedCluster` over
// the apply's `params` output — undefined outputs and a partial cluster are
// refused there — checked against `paramsErrors`. Pure, so the wiring is
// testable without an apply.
export function resolveInfrastructure(opts: Opts, result: Opts): Opts {
  if (failed(result)) return result;
  if (opts["red/event"] === "delete" || opts["red/event"] === "build") return result;
  const resolved = computeCluster.resolvedCluster(validate.spec, opts, result, {}, outputParams(result));
  return failed(resolved) ? resolved : checked(resolved);
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const result = await tofu.tofuWithSpec(opts, infrastructureSpecs(opts), {
    dir: toolDir(opts, infrastructureTool),
    env: credentialEnv(opts, "provider-compute"),
    outputKey: "postgres-ha/outputs",
  });
  return resolveInfrastructure(opts, result);
}

// A state written before this package recorded `params`: the parallel
// `node_public_ips` and `node_private_ips` lists, zipped into the nodes the
// standard describes, with `vpc_id` and `vpc_ip_range` copied and the names
// this package has always given its nodes. Refused, as the SDK's `StepError`,
// when the two lists disagree with each other or with `cluster-nodes` —
// guessing which droplet is which is how a delete destroys around a node — and
// when no `vpc_id` or `vpc_ip_range` was recorded. The range's form is
// `paramsErrors`' to check, the same way for a legacy and a recorded state.
export function legacyParams(opts: Opts, outputs: Record<string, unknown>): computeCluster.ClusterParams {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const publics = list(outputs.node_public_ips);
  const privates = list(outputs.node_private_ips);
  const n = opts["cluster-nodes"];
  if (!(n === publics.length && n === privates.length)) {
    throw new StepError(`legacy state lists ${publics.length} public addresses and `
      + `${privates.length} private addresses; refusing to guess the cluster`);
  }
  for (const k of ["vpc_id", "vpc_ip_range"]) {
    if (!nonBlank(outputs[k])) throw new StepError(`legacy state carries no ${k}`);
  }
  return {
    provider: validate.defaultComputeProvider,
    vpc_id: outputs.vpc_id,
    vpc_ip_range: outputs.vpc_ip_range,
    nodes: Array.from({ length: n as number }, (_, i) => ({
      index: i,
      role: null,
      name: utils.nodeName(opts, i + 1),
      ip: publics[i] as string,
      vpc_ip: privates[i] as string,
      user: "root",
      sudoer: "root",
    })),
  };
}

// The reader ONCE's `readState` takes: the compute `params` recorded in the
// infrastructure state, undefined when the state is readable and holds
// nothing, and the legacy translation when it holds only the pre-adoption
// outputs. Delete needs the cluster before it destroys anything — the local
// SSH configuration is keyed by it — and a `plan` at that moment would be a
// second chance to change infrastructure on the way to removing it; nor can a
// fresh clone re-derive it, so the stage is rendered, its backend written and
// initialized here, before the read. A failed initialization throws the SDK's
// `StepError`, the shape `red/tofu` throws on an unreadable backend;
// `readState` reports both fail-closed. Injectable into `startStep` and
// `loadInfrastructureStep`, so tests never shell out to tofu.
export async function stateOutput(opts: Opts): Promise<computeCluster.ClusterParams | undefined> {
  const dir = toolDir(opts, infrastructureTool);
  const credentials = credentialEnv(opts, "provider-compute");
  scaffold({ ...opts, "red/event": "build" }, infrastructureSpecs(opts));
  await backendAdvice(infrastructureTool)(opts);
  const init = await runtime.exec(
    ["tofu", `-chdir=${dir}`, "init", "-input=false", "-no-color"],
    { env: credentials });
  if (init.exit !== 0) {
    throw new StepError(`infrastructure state initialization failed: ${init.err || init.out || "(no output)"}`);
  }
  const outputs = await tofu.outputs(dir, credentials);
  if ("params" in outputs) return outputs.params as computeCluster.ClusterParams;
  if (Object.keys(outputs).length === 0) return undefined;
  return legacyParams(opts, outputs);
}

// Adopt the cluster out of remote state without planning or mutating cloud
// resources: ONCE's `adoptState` over the read `startStep` handed on under
// `postgres-ha/state`, or a fresh read when nothing was. An unreadable backend
// and a partial cluster fail closed; the adopted `params` must then pass
// `paramsErrors`. A readable state without a cluster means there is nothing to
// clean up on a delete.
export async function loadInfrastructureStep(
  opts: Opts,
  reader: compute.StateReader = stateOutput,
): Promise<Opts> {
  const event = String(opts["red/event"]);
  const { "postgres-ha/state": handed, ...rest } = opts;
  const state = "postgres-ha/state" in opts
    ? handed as compute.StateRead
    : await computeCluster.readState(opts, reader);
  const adopted = computeCluster.adoptState(validate.spec, rest, event, state);
  const present = "once/cluster" in adopted;
  if (failed(adopted)) return adopted;
  const result = checked(adopted);
  if (failed(result)) return result;
  return { ...result, "postgres-ha/infrastructure-present?": present };
}

// ---------------------------------------------------------------------------
// Stage 2 — DNS
//
// One A record per node, all carrying `cluster-host`. libpq resolves the name
// and tries every address it gets back, so a node that is down is skipped by
// the client itself: the endpoint survives a failover without any DNS write,
// and nothing has to hold a cloud API credential at the moment the cluster is
// degraded. See plans/0001 for the alternative that was rejected.

export function dnsData(opts: Opts): Opts {
  return { ...opts, nodes: nodes(opts) };
}

export function dnsSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, dnsTool);
  return [spec(template("dns", "main.tf"), `${dir}/main.tf`, dnsData(opts))];
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  return tofu.tofuWithSpec(opts, dnsSpecs(opts), {
    dir: toolDir(opts, dnsTool),
    env: credentialEnv(opts, "provider-dns"),
    outputKey: "postgres-ha/dns-outputs",
  });
}

// ---------------------------------------------------------------------------
// Shared render data

// The private key every play and the acceptance script reach the nodes with:
// the generated key's path in keygen mode (the build placeholder on a build or
// a dry-run), the operator's `digitalocean-ssh-private-key` in opt-out mode.
export function privateKeyFile(opts: Opts): string {
  return validate.keygen(opts)
    ? String(opts["ssh-private-key-path"])
    : String(opts["digitalocean-ssh-private-key"] ?? "");
}

// Template data: the topology, the adopted cluster's `vpc_ip_range` winning
// over the fallback on a real run, and the machine-key paths keygen mode owns.
export function dataFn(opts: Opts): Opts {
  opts = ssh.withMachineKey(opts);
  const ns = nodes(opts);
  const recorded = (opts["once/cluster"] ?? {}) as Opts;
  const facts = { ...fallbackOutputs,
    ...Object.fromEntries(Object.keys(fallbackOutputs).filter((k) => k in recorded).map((k) => [k, recorded[k]])) };
  const etcdVersion = String(opts["etcd-version"] ?? "");
  return {
    ...opts,
    nodes: ns,
    "first-node": ns[0],
    "vpc-cidr": facts.vpc_ip_range,
    "ssh-private-key": privateKeyFile(opts),
    "backup-r2-s3-endpoint": utils.endpointHost(opts["backup-r2-endpoint"]),
    "backup-repo-path": utils.repoPath(opts["backup-r2-prefix"]),
    "etcd-tarball": `etcd-${etcdVersion}-linux-amd64.tar.gz`,
    "etcd-url": "https://github.com/etcd-io/etcd/releases/download/" +
      `${etcdVersion}/etcd-${etcdVersion}-linux-amd64.tar.gz`,
    "postgres-data-dir": `/var/lib/postgresql/${opts["postgres-version"]}/main`,
    "postgres-bin-dir": `/usr/lib/postgresql/${opts["postgres-version"]}/bin`,
    "admin-password-lookup": utils.parLookup("postgres-admin-password"),
    "replication-password-lookup": utils.parLookup("postgres-replication-password"),
    "backup-key-lookup": utils.parLookup("backup-r2-access-key-id"),
    "backup-secret-lookup": utils.parLookup("backup-r2-secret-access-key"),
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — local SSH configuration

// Only what a `build` genuinely knows. Addresses are run-time facts and reach
// the play as extra-vars instead, so the rendered playbook carries no IP and is
// identical on every workstation (SSH Config Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...dataFn(opts),
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
    "host-alias": sshConfig.hostAlias(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  return [
    spec(template("ansible-local", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local", "inventory.ini"), `${dir}/inventory.ini`, data),
    spec(template("ansible-local", "main.yml"), `${dir}/main.yml`, data),
  ];
}

// The `~/.ssh/config` entries, as data the play loops over: the bare profile
// pointing at node 0 (the spec's entry), then one alias per node. ONCE's
// (Compute Cluster Standard §6).
export function sshConfigHosts(opts: Opts): computeCluster.SshConfigHost[] {
  return computeCluster.sshConfigHosts(validate.spec, opts, clusterNodes(opts));
}

// What the play cannot know from a `build`: the aliases and addresses, which
// are run-time facts and stay out of the rendered playbook so the committed
// goldens carry no address (ssh-config.md §6), and `block_state` — `present`
// on create, `absent` on delete — because the same playbook file serves both
// events. The identity file is desired state a build does know and reaches
// the play through Selmer instead.
export function ansibleLocalExtraVars(opts: Opts): Record<string, unknown> {
  return {
    host_alias: sshConfig.hostAlias(opts),
    ssh_hosts: sshConfigHosts(opts),
    block_state: opts["red/event"] === "delete" ? "absent" : "present",
  };
}

export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  return ansible.ansibleWithSpec(opts, {
    dir: toolDir(opts, ansibleLocalTool),
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: ansibleLocalExtraVars(opts),
  }, ansibleLocalSpecs(opts));
}

// ---------------------------------------------------------------------------
// Stage 4 — the cluster itself

// Java's Double.toString, which is what Cheshire renders floats through and
// therefore what green's committed inventory bytes would carry. Integral
// numbers print as longs. JS's shortest-round-trip digits are the same digits
// Java chooses; only the layout differs.
function javaNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const negative = value < 0;
  const [mantissa, exponentPart] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentPart);
  const digits = mantissa!.replace(".", "");
  let body: string;
  if (exponent >= -3 && exponent < 7) {
    if (exponent >= 0) {
      const intPart = digits.padEnd(exponent + 1, "0").slice(0, exponent + 1);
      const fracPart = digits.slice(exponent + 1);
      body = `${intPart}.${fracPart.length > 0 ? fracPart : "0"}`;
    } else {
      body = `0.${"0".repeat(-exponent - 1)}${digits}`;
    }
  } else {
    const rest = digits.slice(1);
    body = `${digits[0]}.${rest.length > 0 ? rest : "0"}E${exponent}`;
  }
  return negative ? `-${body}` : body;
}

// Cheshire's pretty printer, byte for byte: spaces around colons, arrays
// inline, nested objects newline-indented, floats in Java notation.
function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  if (typeof value === "number") return javaNumber(value);
  return JSON.stringify(value ?? null);
}

// A JSON inventory rather than INI: the per-host facts the templates need are
// structured, and `private_ip` in particular is what every generated etcd,
// Patroni and HAProxy stanza is built from.
export function inventory(opts: Opts): string {
  const data = dataFn(opts);
  const hosts: Record<string, Opts> = {};
  for (const node of [...(data.nodes as Node[])]
         .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hosts[node.name] = {
      ansible_host: node["public-ip"],
      ansible_user: "root",
      private_ip: node["private-ip"],
      node_ordinal: node.ordinal,
    };
  }
  return pretty({
    all: {
      children: {
        postgres: {
          hosts,
          vars: { ansible_ssh_private_key_file: data["ssh-private-key"] },
        },
      },
    },
  });
}

// The scripts and units that carry the backup, PITR-continuity and
// verified-restore schedule. All three pairs are installed on all three nodes;
// each asks Patroni what it is before doing anything, so the schedule follows
// the leader lock instead of a node name.
export const scheduledWorkTemplates = [
  "postgres-ha-heartbeat", "postgres-ha-heartbeat.service",
  "postgres-ha-heartbeat.timer",
  "postgres-ha-backup", "postgres-ha-backup.service", "postgres-ha-backup.timer",
  "postgres-ha-restore-check", "postgres-ha-restore-check.service",
  "postgres-ha-restore-check.timer",
];

export function clusterSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, clusterTool);
  const data = dataFn(opts);
  return [
    spec(template("ansible-remote", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible-remote", "main.yml"), `${dir}/main.yml`, data),
    spec(template("ansible-remote", "cleanup.yml"), `${dir}/cleanup.yml`, data),
    spec(template("ansible-remote", "etcd.conf.yml.j2"),
         `${dir}/templates/etcd.conf.yml.j2`, data),
    spec(template("ansible-remote", "etcd.service.j2"),
         `${dir}/templates/etcd.service.j2`, data),
    spec(template("ansible-remote", "patroni.yml.j2"),
         `${dir}/templates/patroni.yml.j2`, data),
    spec(template("ansible-remote", "patroni.service.j2"),
         `${dir}/templates/patroni.service.j2`, data),
    spec(template("ansible-remote", "haproxy.cfg.j2"),
         `${dir}/templates/haproxy.cfg.j2`, data),
    spec(template("ansible-remote", "pgbackrest.conf.j2"),
         `${dir}/templates/pgbackrest.conf.j2`, data),
    rawSpec(`${dir}/inventory.json`, inventory(opts)),
    // The nine scheduled-work files are listed once, here, because the
    // playbook loops over the same names when it installs them. Two lists
    // that had to be kept in step by hand is how a unit ends up rendered but
    // never enabled.
    ...scheduledWorkTemplates.map((unit) =>
      spec(template("ansible-remote", `${unit}.j2`),
           `${dir}/templates/${unit}.j2`, data)),
  ];
}

export async function clusterStep(opts: Opts): Promise<Opts> {
  if (opts["red/event"] === "delete" &&
      opts["postgres-ha/infrastructure-present?"] === false) {
    return scaffold(opts, clusterSpecs(opts));
  }
  return ansible.ansibleWithSpec(opts, {
    dir: toolDir(opts, clusterTool),
    inventory: "inventory.json",
    playbooks: { create: "main.yml", delete: "cleanup.yml" },
    hostKeyChecking: false,
    recapKey: "postgres-ha/cluster-recap",
  }, clusterSpecs(opts));
}

// ---------------------------------------------------------------------------
// Stage 5 — acceptance

export function acceptanceSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, acceptanceTool);
  return [spec(template("acceptance", "acceptance.sh"),
               `${dir}/acceptance.sh`, dataFn(opts))];
}

export function processResult(
  opts: Opts, label: string,
  result: { exit: number; out: string; err: string },
): Opts {
  if (result.exit === 0) return { ...opts, "red/exit": 0 };
  return {
    ...opts,
    "red/exit": Math.max(1, result.exit),
    "red/err": `${label} failed: ${result.err || result.out || "(no output)"}`,
  };
}

// The credential the acceptance script authenticates with, taken from opts
// rather than read again from the ambient environment so a `COLORS_PAR_*`
// overlay and a desired-state value cannot disagree. The extra environment is
// added to the inherited one, so nothing else has to be repeated here.
export function acceptanceEnv(opts: Opts): Record<string, string> {
  return { PGPASSWORD: String(opts["postgres-admin-password"] ?? "") };
}

export async function acceptanceStep(opts: Opts): Promise<Opts> {
  const rendered = scaffold(opts, acceptanceSpecs(opts));
  if (opts["red/event"] !== "create") return rendered;
  const result = await runtime.exec(
    ["bash", `${toolDir(opts, acceptanceTool)}/acceptance.sh`],
    { env: acceptanceEnv(opts), timeoutMs: 20 * 60 * 1000 });
  // The script's own transcript is the evidence a health check produced.
  // Printing it on success as well as failure is the difference between
  // "acceptance passed" and knowing which eight things it asserted.
  if (result.out.length) console.log(result.out);
  return processResult(rendered, "acceptance", result);
}

export function generatedCleanupStep(opts: Opts): Opts {
  return scaffold(scaffold(opts, ansibleLocalSpecs(opts)), acceptanceSpecs(opts));
}
