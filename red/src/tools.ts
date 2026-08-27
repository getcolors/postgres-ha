// The five stages: DigitalOcean infrastructure, Cloudflare DNS, local SSH
// configuration, the remote cluster convergence, and acceptance — the port of
// io.github.getcolors.postgres-ha.tools.
//
// Every stage renders into `.colors/<profile>/<stage>/` and, for the OpenTofu
// ones, keys its remote state at `<profile>/<stage>.tfstate`. Those two names
// are the deployment's identity; changing either orphans live infrastructure,
// so they are constants here and asserted by the golden suite.

import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { toolEnv } from "red/providers";
import { runtime } from "red/runtime";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
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

export function cidrs(opts: Opts, key: string): string[] {
  const value = opts[key];
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  return items.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

// ---------------------------------------------------------------------------
// Placeholder topology
//
// `build` renders the whole tree without contacting a provider, so it needs
// addresses that are obviously not real. RFC 5737 TEST-NET-1 and RFC 1918
// values make a golden file that leaks into a real run fail loudly rather than
// point at somebody's host, and they keep the goldens a pure function of
// colors.yml.

export const fallbackOutputs: Opts = {
  vpc_id: "00000000-0000-0000-0000-000000000000",
  vpc_ip_range: "10.114.0.0/20",
  node_public_ips: ["192.0.2.11", "192.0.2.12", "192.0.2.13"],
  node_private_ips: ["10.114.0.11", "10.114.0.12", "10.114.0.13"],
};

function outputMap(result: Opts): Opts | undefined {
  return result["postgres-ha/outputs"] as Opts | undefined;
}

export interface Node {
  ordinal: number;
  name: string;
  alias: string;
  "public-ip": string;
  "private-ip": string;
}

// The rendered topology: one map per ordinal, joined with whatever addresses
// the infrastructure stage produced (or the placeholders, before it has run).
export function nodes(opts: Opts): Node[] {
  const fallbackPublic = fallbackOutputs.node_public_ips as string[];
  const fallbackPrivate = fallbackOutputs.node_private_ips as string[];
  const publicIps = (opts.node_public_ips as string[] | undefined) ?? fallbackPublic;
  const privateIps = (opts.node_private_ips as string[] | undefined) ?? fallbackPrivate;
  return utils.ordinals().map((n) => {
    const i = n - 1;
    return {
      ordinal: n,
      name: utils.nodeName(opts, n),
      alias: utils.sshAlias(opts, n),
      "public-ip": publicIps[i] ?? fallbackPublic[i]!,
      "private-ip": privateIps[i] ?? fallbackPrivate[i]!,
    };
  });
}

// ---------------------------------------------------------------------------
// Stage 1 — infrastructure

export function infrastructureData(opts: Opts): Opts {
  return {
    ...opts,
    "node-names-hcl": tofu.hclList(utils.ordinals().map((n) => utils.nodeName(opts, n))),
    "ssh-keys-hcl": tofu.hclList(cidrs(opts, "digitalocean-ssh-keys")),
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, "digitalocean-ssh-sources")),
    "client-sources-hcl": tofu.hclList(cidrs(opts, "digitalocean-client-sources")),
  };
}

export function infrastructureSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, infrastructureTool);
  return [spec(template("infrastructure", "main.tf"), `${dir}/main.tf`,
               infrastructureData(opts))];
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const result = await tofu.tofuWithSpec(opts, infrastructureSpecs(opts), {
    dir: toolDir(opts, infrastructureTool),
    env: credentialEnv(opts, "provider-compute"),
    outputKey: "postgres-ha/outputs",
  });
  if (failed(result)) return result;
  if (opts["red/event"] === "delete") return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackOutputs };
  return { ...result, ...fallbackOutputs, ...(outputMap(result) ?? {}) };
}

// Read node addresses out of remote state without planning or mutating cloud
// resources.
//
// Delete needs the addresses before it destroys anything — the local SSH
// configuration is keyed by them — and a `plan` at that moment would be a
// second chance to change infrastructure on the way to removing it.
export async function loadInfrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const rendered = {
    ...scaffold({ ...opts, "red/event": "build" }, infrastructureSpecs(opts)),
    "red/event": opts["red/event"],
  };
  const credentials = credentialEnv(opts, "provider-compute");
  const init = await runtime.exec(
    ["tofu", `-chdir=${dir}`, "init", "-input=false", "-no-color"],
    { env: credentials });
  if (init.exit !== 0) {
    return processResult(rendered, "infrastructure state initialization", init);
  }
  try {
    const outputs = await tofu.outputs(dir, credentials);
    return {
      ...rendered, ...fallbackOutputs, ...outputs,
      "postgres-ha/infrastructure-present?": "node_public_ips" in outputs,
    };
  } catch (t) {
    return {
      ...rendered, "red/exit": 1,
      "red/err": "infrastructure state output failed: " +
        (t instanceof Error ? t.message || t.constructor.name : String(t)),
    };
  }
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

export function dataFn(opts: Opts): Opts {
  const ns = nodes(opts);
  const etcdVersion = String(opts["etcd-version"] ?? "");
  return {
    ...opts,
    nodes: ns,
    "first-node": ns[0],
    "vpc-cidr": opts.vpc_ip_range ?? fallbackOutputs.vpc_ip_range,
    "ssh-private-key": String(opts["digitalocean-ssh-private-key"] ?? ""),
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

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = dataFn(opts);
  return [
    spec(template("ansible-local", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local", "inventory.ini"), `${dir}/inventory.ini`, data),
    spec(template("ansible-local", "main.yml"), `${dir}/main.yml`, data),
  ];
}

export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const data = dataFn(opts);
  const isDelete = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir: toolDir(opts, ansibleLocalTool),
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      block_state: isDelete ? "absent" : "present",
      nodes: (data.nodes as Node[]).map(({ alias, ordinal, ...node }) => ({
        alias, "public-ip": node["public-ip"], ordinal,
      })),
      ssh_private_key: data["ssh-private-key"],
    },
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
