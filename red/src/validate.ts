
import { parName } from "red/cli";
import type { Registry } from "red/providers";
import type { Opts } from "red/workflow";
import {registry,validate as computeValidate,plan_deployment,keyMode,source_cidrs} from "colors-compute-red";
import * as compute from "./compute.ts";

import * as utils from "./utils.ts";

export const computeProviders=registry.compute;
export const defaultComputeProvider='digitalocean';
export const providers: Registry = {

  "provider-dns": {
    cloudflare: {
      required: ["cloudflare-zone", "cloudflare-proxied", "cloudflare-record-ttl",
                 "cluster-host"],
      secrets: ["cloudflare-api-token"],
      tofuEnv: { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" },
    },
  },

  "provider-backend": Object.fromEntries(Object.entries(registry.backend).map(([key,value])=>[key,{required:value.required,secrets:value.secrets,tofuEnv:{}}])),
};

export const slots = ["provider-compute", "provider-dns", "provider-backend"];

export const ownSlots = ["provider-dns", "provider-backend"];

export const profilePar = parName("profile");

export const ownRequired = [
  "profile", "workdir", "cluster-name", "cluster-host", "cluster-nodes",
  "postgres-version", "postgres-port", "postgres-database",
  "postgres-admin-user", "postgres-replication-user",
  "patroni-package-version", "patroni-rest-port", "patroni-ttl",
  "patroni-loop-wait", "patroni-retry-timeout", "patroni-synchronous-node-count",
  "etcd-version", "etcd-sha256", "etcd-client-port", "etcd-peer-port",
  "haproxy-version", "haproxy-primary-port", "haproxy-replica-port",
  "haproxy-stats-port", "client-connect-timeout-seconds",
  "pgbackrest-package-version", "backup-stanza", "backup-oncalendar",
  "backup-retention-full", "restore-check-oncalendar", "restore-check-port",
  "restore-check-max-age-hours", "restore-check-max-lag-seconds",
  "heartbeat-oncalendar", "heartbeat-retention-days",
  "backup-r2-bucket", "backup-r2-endpoint", "backup-r2-region", "backup-r2-prefix",
];

export const ownSecrets = [
  "postgres-admin-password", "postgres-replication-password",
  "backup-r2-access-key-id", "backup-r2-secret-access-key",
];

export function placeholder(x: unknown): boolean {
  return x == null ||
    (typeof x === "string" && (!x.trim() || x.toUpperCase() === "REPLACE_ME"));
}

export function keygen(opts: Opts): boolean {
  try{return keyMode(opts).mode==='managed';}catch{return true;}
}

interface Entry { required?: string[]; secrets?: string[]; tofuEnv?: Record<string, string> }

export function entry(opts: Opts, slot: string): Entry | undefined {
  return (providers as Record<string, Record<string, Entry>>)[slot]?.[String(opts[slot])];
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  return entry(opts, slot)?.tofuEnv ?? {};
}

function slotKeys(opts: Opts, selected: string[], field: "required" | "secrets"): string[] {
  return selected.flatMap((slot) => entry(opts, slot)?.[field] ?? []);
}

function missing(opts: Opts, keys: string[]): string[] {
  return keys.filter((key) => placeholder(opts[key]));
}

export function envErrors(env: Record<string, string | undefined>): string[] | undefined {
  if (String(env[profilePar] ?? "").length) {
    return [`${profilePar} is set. postgres-ha takes profile from colors.yml only; ` +
            "an environment overlay could point this deployment at another's " +
            "remote state and backup repository."];
  }
  return undefined;
}

const dnsRe =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const profileRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const identifierRe = /^[a-z_][a-z0-9_]{0,62}$/;
const stanzaRe = /^[a-z][a-z0-9-]{0,31}$/;
const etcdVersionRe = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
// A Debian version, not a release version: PGDG revisions its own packaging
// (`4.1.5-1.pgdg24.04+1`), and a pin that named only the upstream release
// would still let two converges install different bytes.
const debVersionRe = /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.+~:-]+$/;
const sha256Re = /^[0-9a-f]{64}$/;
const oncalendarRe = /^[A-Za-z0-9 *,./:-]+$/;
const httpsRe = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/;
const prefixRe = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function positiveInt(x: unknown): boolean {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

// pr-str, for the unsupported-provider message: green prints the offending
// value through pr-str, which quotes strings and renders nil bare.
function prStr(value: unknown): string {
  if (value == null) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

// Listeners that must each own a distinct port on every node.
//
// `postgres-port` is deliberately absent. PostgreSQL binds only the node's
// private VPC address, while HAProxy binds only the public address and
// loopback, so the primary listener is expected to reuse 5432 — a client
// reaching `<cluster-host>:5432` and a replica streaming from
// `<private-ip>:5432` never contend. Every other listener here shares an
// address with at least one of the others, so a repeated number is a node
// that half-starts.
const exclusivePortKeys = [
  "patroni-rest-port", "etcd-client-port", "etcd-peer-port",
  "haproxy-primary-port", "haproxy-replica-port", "haproxy-stats-port",
  "restore-check-port",
];

function distinctPortErrors(opts: Opts): string[] {
  const ports: Array<[string, number]> = [];
  for (const key of exclusivePortKeys) {
    const value = opts[key];
    if (typeof value === "number" && Number.isInteger(value)) ports.push([key, value]);
  }
  const grouped = new Map<number, string[]>();
  for (const [key, value] of ports) {
    grouped.set(value, [...(grouped.get(value) ?? []), key]);
  }
  const dupes = [...grouped.entries()]
    .filter(([, keys]) => keys.length > 1)
    .sort(([a], [b]) => a - b);
  const pg = opts["postgres-port"];
  const shadowed = typeof pg === "number" && Number.isInteger(pg)
    ? ports.filter(([key, value]) => value === pg && key !== "haproxy-primary-port")
        .map(([key]) => key)
    : [];
  return [
    ...dupes.map(([port, keys]) =>
      `port ${port} is claimed by ${keys.join(" and ")}; ` +
      "every listener on a node needs its own port"),
    ...shadowed.sort().map((key) => `:${key} must differ from :postgres-port`),
  ];
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  const push = (condition: unknown, message: string) => {
    if (condition) errors.push(message);
  };

  for (const key of missing(opts, [...ownRequired,
                                   ...slotKeys(opts, ownSlots, "required")])) {
    errors.push(`:${key} is required`);
  }

  for (const slot of ownSlots) {
    if (!entry(opts, slot)) errors.push(`unsupported :${slot} ${prStr(opts[slot])}`);
  }

  push(opts["provider-dns"] !== "cloudflare", ":provider-dns must be cloudflare");
  push(typeof opts["compute-prevent-destroy"] !== "boolean",
       ":compute-prevent-destroy must be true or false");
  push(typeof opts["cloudflare-proxied"] !== "boolean",
       ":cloudflare-proxied must be true or false");
  push(opts["cloudflare-proxied"] === true,
       ":cloudflare-proxied must be false; Cloudflare's proxy does not carry the PostgreSQL wire protocol");

  push(!(placeholder(opts.profile) || profileRe.test(String(opts.profile))),
       ":profile must be a safe 1-63 character name");

  // Opt-out mode reaches the nodes with the operator's own key, so the path to
  // it is desired state there; keygen mode names the generated key itself and
  // must not be asked for one.
  push(!keygen(opts) && placeholder(keyMode(opts).private_key_path),
       ":ssh-private-key-path is required for external SSH access");

  push(opts["cluster-nodes"] !== utils.nodeCount,
       `:cluster-nodes must be ${utils.nodeCount}; the topology colocates a ` +
       "quorum store on the database nodes and cannot elect with fewer");



  for (const key of ["cluster-host", "cloudflare-zone"]) {
    const value = opts[key];
    push(!placeholder(value) && !dnsRe.test(String(value)),
         `:${key} must be a DNS name`);
  }
  const host = String(opts["cluster-host"]);
  const zone = String(opts["cloudflare-zone"]);
  push(!placeholder(opts["cluster-host"]) && !placeholder(opts["cloudflare-zone"]) &&
       !(host === zone || host.endsWith(`.${zone}`)),
       ":cluster-host must be inside :cloudflare-zone");

  const pgVersion = opts["postgres-version"];
  push(!positiveInt(pgVersion),
       ":postgres-version must be a PostgreSQL major version integer such as 17");
  push(typeof pgVersion === "number" && Number.isInteger(pgVersion) && pgVersion < 15,
       ":postgres-version must be 15 or later; the topology relies on quorum synchronous commit and pg_rewind");

  for (const key of ["patroni-package-version", "pgbackrest-package-version"]) {
    const value = opts[key];
    push(!placeholder(value) && !debVersionRe.test(String(value)),
         `:${key} must be a full Debian package version such as 4.1.5-1.pgdg24.04+1`);
  }
  push(!(placeholder(opts["etcd-version"]) ||
         etcdVersionRe.test(String(opts["etcd-version"]))),
       ":etcd-version must be an exact vX.Y.Z release tag");
  push(!(placeholder(opts["etcd-sha256"]) ||
         sha256Re.test(String(opts["etcd-sha256"]))),
       ":etcd-sha256 must be the lowercase hex SHA-256 of the linux-amd64 release tarball");
  push(!(placeholder(opts["haproxy-version"]) ||
         /^[0-9]+\.[0-9]+$/.test(String(opts["haproxy-version"]))),
       ":haproxy-version must be a distribution major.minor series such as 2.8");

  for (const key of ["postgres-database", "postgres-admin-user", "postgres-replication-user"]) {
    const value = opts[key];
    push(!placeholder(value) && !identifierRe.test(String(value)),
         `:${key} must be an unquoted lowercase SQL identifier`);
  }
  push(!placeholder(opts["postgres-admin-user"]) &&
       String(opts["postgres-admin-user"]) === String(opts["postgres-replication-user"]),
       ":postgres-replication-user must differ from :postgres-admin-user");

  push(!(placeholder(opts["backup-stanza"]) ||
         stanzaRe.test(String(opts["backup-stanza"]))),
       ":backup-stanza must be a short lowercase pgBackRest stanza name");
  push(!(placeholder(opts["backup-r2-endpoint"]) ||
         httpsRe.test(String(opts["backup-r2-endpoint"]))),
       ":backup-r2-endpoint must be an https:// origin");
  push(!(placeholder(opts["backup-r2-prefix"]) ||
         prefixRe.test(String(opts["backup-r2-prefix"]))),
       ":backup-r2-prefix must be a relative object-key prefix");
  push(!placeholder(opts["backup-r2-bucket"]) && !placeholder(opts["r2-bucket"]) &&
       String(opts["backup-r2-bucket"]) === String(opts["r2-bucket"]),
       ":backup-r2-bucket must not be the OpenTofu state bucket; backups and state do not share a blast radius");

  for (const key of ["cluster-nodes", "postgres-port", "patroni-ttl",
                     "patroni-loop-wait", "patroni-retry-timeout",
                     "patroni-synchronous-node-count", "backup-retention-full",
                     "restore-check-max-age-hours", "restore-check-max-lag-seconds",
                     "heartbeat-retention-days", "cloudflare-record-ttl",
                     "client-connect-timeout-seconds", ...exclusivePortKeys]) {
    push(!positiveInt(opts[key]), `:${key} must be a positive integer`);
  }
  errors.push(...distinctPortErrors(opts));
  // Cloudflare accepts 1 (automatic) or 60..86400. A short explicit TTL is
  // what lets a replaced node leave the endpoint's address set quickly.
  const ttl = opts["cloudflare-record-ttl"];
  const ttlNumber = typeof ttl === "number" ? ttl : 0;
  push(!(ttlNumber === 1 || (60 <= ttlNumber && ttlNumber <= 86400)),
       ":cloudflare-record-ttl must be 1 (automatic) or between 60 and 86400");

  // The endpoint resolves to every node, so a client may try an address whose
  // machine is powered off. That address does not refuse the connection, it
  // black-holes the SYN, and libpq's default is to wait out the OS TCP retry
  // — about two minutes — before trying the next one. This is the value the
  // documentation and the acceptance probe both use; it is desired state
  // rather than folklore precisely because getting it wrong turns a
  // survivable node loss into an outage for a third of new connections.
  const connectTimeout = opts["client-connect-timeout-seconds"];
  const connectNumber = typeof connectTimeout === "number" ? connectTimeout : 0;
  push(!(1 <= connectNumber && connectNumber <= 30),
       ":client-connect-timeout-seconds must be between 1 and 30; it " +
       "bounds how long a client waits on a powered-off node's address " +
       "before trying the next one in the endpoint's record set");

  const syncCount = opts["patroni-synchronous-node-count"];
  const syncNumber = typeof syncCount === "number" ? syncCount : 0;
  push(!(0 < syncNumber && syncNumber < utils.nodeCount),
       `:patroni-synchronous-node-count must be between 1 and ${utils.nodeCount - 1}; ` +
       "requiring every standby to acknowledge stalls writes when one node is lost");
  const loopWait = opts["patroni-loop-wait"];
  const patroniTtl = opts["patroni-ttl"];
  push(!(typeof loopWait === "number" && Number.isInteger(loopWait) &&
         typeof patroniTtl === "number" && Number.isInteger(patroniTtl) &&
         2 * loopWait < patroniTtl),
       ":patroni-ttl must exceed twice :patroni-loop-wait, or the leader lock can expire between health checks");

  for (const key of ["backup-oncalendar", "restore-check-oncalendar", "heartbeat-oncalendar"]) {
    const value = opts[key];
    push(!placeholder(value) && !oncalendarRe.test(String(value)),
         `:${key} must be a systemd OnCalendar expression`);
  }

  // The verified restore asserts that a heartbeat written after the last
  // backup survived the round trip through the archive. Its tolerance has to
  // leave room for `archive_timeout` plus the restore itself, or the check
  // fails on a healthy cluster and stops meaning anything.
  const maxLag = opts["restore-check-max-lag-seconds"];
  const maxLagNumber = typeof maxLag === "number" ? maxLag : 0;
  push(!(120 < maxLagNumber),
       ":restore-check-max-lag-seconds must exceed 120; below that it " +
       "fails on a healthy cluster, because a segment is only archived " +
       "once archive_timeout elapses");

  errors.push(...computeValidate(opts));
  if(!errors.length)try{plan_deployment(opts,compute.topology(opts),compute.requirements(opts));}catch(error){errors.push((error as Error).message);}

  for (const key of ["ssh-sources", "client-sources"]) {
    push(source_cidrs(opts,key,"postgres-"+key).some((value) => value === "0.0.0.0/0"),
         `:${key} must not contain 0.0.0.0/0; administrative and database ingress stay scoped`);
  }

  return errors;
}

export function secretErrors(opts: Opts, selected: string[] = slots): string[] {
  return [...new Set(missing(opts, [...ownSecrets, ...slotKeys(opts, selected, "secrets")]))]
    .map((key) => `required credential is not set: ${parName(key)}`);
}
