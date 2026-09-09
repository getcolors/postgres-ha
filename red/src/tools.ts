
import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { toolEnv } from "red/providers";
import { runtime } from "red/runtime";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import {providers as onceBackends} from "package-once-red";
import {orchestrate,plan_deployment,read_deployment} from "colors-compute-red";
import * as compute from "./compute.ts";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname} from "node:path";
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
  return toolEnv({...validate.providers,"provider-backend":onceBackends["provider-backend"]!}, opts, [...slots, "provider-backend"]);
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


export interface Node {ordinal:number;name:string;alias:string;'public-ip':string;'private-ip':string;user:string}
const clusterNodes=(opts:Opts)=>compute.resolved(opts);
export const sshAlias=(opts:Opts,n:number)=>opts.profile+'-'+(n-1);
export function nodes(opts: Opts): Node[] {
  return clusterNodes(opts).map((node) => {
    const ordinal = node.index + 1;
    return {
      ordinal,
      name: String(node.name),
      alias: sshAlias(opts, ordinal),
      "public-ip": String(node.ip),
      "private-ip": String(node.vpc_ip),user:node.user,
    };
  });
}

// ---------------------------------------------------------------------------
// Stage 1 — infrastructure

export async function infrastructureStep(opts:Opts):Promise<Opts>{
 const planning=opts['red/event']==='build'||opts['red/dry-run'];
 const result:any=planning?plan_deployment(opts,compute.topology(opts),compute.requirements(opts)):await orchestrate(opts,compute.topology(opts),compute.requirements(opts));
 if(!['planned','ready','destroyed'].includes(result.status))return refuse(opts,result.errors?.length?result.errors:['compute lifecycle refused; legacy monolithic state requires explicit migration']);
 if(planning){
  const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
  for(const [stage,docs] of [['shared',result.documents.shared],...Object.entries(result.documents.nodes).map(([id,docs])=>['nodes/'+id,docs])] as [string,Record<string,any>][])
   for(const [filename,document] of Object.entries(docs)){const target=toolDir(opts,infrastructureTool)+'/'+stage+'/'+filename;mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(sorted(document),null,2)+'\n');}
 }
 const values:Opts={...opts,'red/exit':0};if(result.cluster){values['colors-compute/cluster']=result.cluster;values['colors-compute/shared']=result.shared??{};}
 if(result.key?.private_key_path)values['ssh-private-key-path']=planning?result.key.private_key_path.replace('$HOME/.ssh','/home/build-placeholder/.ssh'):result.key.private_key_path;
 return values;
}
export async function loadInfrastructureStep(opts:Opts,reader:typeof read_deployment=read_deployment):Promise<Opts>{
 if(opts['red/event']==='build'||opts['red/dry-run'])return infrastructureStep(opts);
 const result:any=await reader(opts);if(result.status==='destroyed')return {...opts,'postgres-ha/already-destroyed':true,'red/exit':0};
 if(result.status!=='present')return refuse(opts,['compute state unavailable; legacy monolithic state requires explicit migration']);
 return {...opts,'colors-compute/cluster':result.cluster,'colors-compute/shared':result.shared??{},'postgres-ha/infrastructure-present?':true,...(result.key?.private_key_path?{'ssh-private-key-path':result.key.private_key_path}:{}),'red/exit':0};
}

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

export const privateKeyFile=(opts:Opts)=>String(opts['ssh-private-key-path']??'');

export function dataFn(opts: Opts): Opts {
  opts = ssh.withMachineKey(opts);
  const ns = nodes(opts);
  const shared=opts['colors-compute/shared']??((opts['red/event']==='build'||opts['red/dry-run'])?plan_deployment(opts,compute.topology(opts),compute.requirements(opts)).shared:{});
  const facts=shared.params??{};if(!facts.network_cidr)throw Error('compute shared network CIDR unavailable');
  const etcdVersion = String(opts["etcd-version"] ?? "");
  return {
    ...opts,
    nodes: ns,
    "first-node": ns[0],
    "vpc-cidr": facts.network_cidr,
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
  opts=ssh.withMachineKey(opts);
  return {
    ...dataFn(opts),
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": validate.keygen(opts) ? sshConfig.identityFile(opts) : opts["ssh-private-key-path"] || "",
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

export function sshConfigHosts(opts:Opts){const list=clusterNodes(opts);return [{...list[0],name:opts.profile},...list.map(node=>({...node,name:opts.profile+'-'+node.index}))];}

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
      ansible_user: node.user,
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
