// Credential-free desired-state validation, and the provider registry it
// uses — the port of io.github.getcolors.postgres-ha.validate.
//
// The registry is package-owned rather than inherited from ONCE: this package
// provisions three droplets, its own firewall and its own DNS record set, so
// the keys a stage interpolates are not ONCE's single-server keys.
//
// Green renders its keys as Clojure keywords, so every message here carries
// the same leading colon — the three colours must report identical errors for
// one colors.yml.
//
// Every check accumulates. A run reports all of a file's problems at once with
// exit 2, because fixing desired state one error per invocation is how a
// person gives up on a config file.

import { parName } from "red/cli";
import type { Registry } from "red/providers";
import type { Opts } from "red/workflow";
import * as utils from "./utils.ts";

export const providers: Registry = {
  "provider-compute": {
    digitalocean: {
      required: ["digitalocean-name", "digitalocean-region", "digitalocean-size",
                 "digitalocean-image", "digitalocean-ssh-keys",
                 "digitalocean-ssh-private-key", "digitalocean-ssh-sources",
                 "digitalocean-client-sources", "digitalocean-vpc-mode"],
      secrets: ["do-token"],
      tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
    },
  },

  "provider-dns": {
    cloudflare: {
      required: ["cloudflare-zone", "cloudflare-proxied", "cloudflare-record-ttl",
                 "cluster-host"],
      secrets: ["cloudflare-api-token"],
      tofuEnv: { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" },
    },
  },

  "provider-backend": {
    local: { required: [], secrets: [], tofuEnv: {} },
    s3: {
      required: ["s3-bucket", "s3-region"],
      secrets: ["s3-access-key-id", "s3-secret-access-key"],
      tofuEnv: { "s3-access-key-id": "AWS_ACCESS_KEY_ID",
                 "s3-secret-access-key": "AWS_SECRET_ACCESS_KEY" },
    },
    // R2 is S3-compatible and therefore authenticates through the AWS chain.
    // These are the *state* credentials; the backup repository has its own
    // pair so a leaked backup key cannot rewrite infrastructure state.
    r2: {
      required: ["r2-bucket", "r2-endpoint"],
      secrets: ["r2-access-key-id", "r2-secret-access-key"],
      tofuEnv: { "r2-access-key-id": "AWS_ACCESS_KEY_ID",
                 "r2-secret-access-key": "AWS_SECRET_ACCESS_KEY" },
    },
  },
};

export const slots = ["provider-compute", "provider-dns", "provider-backend"];
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

// A VPC is discovered, never described. Accepting any of these would let one
// deployment place its nodes on another's network while still passing every
// other check, so their mere presence is an error rather than a warning.
export const forbiddenVpcKeys = [
  "digitalocean-vpc-id", "digitalocean-vpc-uuid", "digitalocean-vpc-cidr",
  "digitalocean-vpc-name", "digitalocean-vpc",
];

export function placeholder(x: unknown): boolean {
  return x == null ||
    (typeof x === "string" && (!x.trim() || x.toUpperCase() === "REPLACE_ME"));
}

interface Entry { required?: string[]; secrets?: string[]; tofuEnv?: Record<string, string> }

export function entry(opts: Opts, slot: string): Entry | undefined {
  return (providers as Record<string, Record<string, Entry>>)[slot]?.[String(opts[slot])];
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  return entry(opts, slot)?.tofuEnv ?? {};
}

function slotKeys(opts: Opts, field: "required" | "secrets"): string[] {
  return slots.flatMap((slot) => entry(opts, slot)?.[field] ?? []);
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
const cidrRe = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
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

export function validCidr(value: unknown): boolean {
  const text = String(value);
  if (!cidrRe.test(text)) return false;
  return text.split("/")[0]!.split(".").every((octet) => Number(octet) <= 255);
}

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

  for (const key of missing(opts, [...ownRequired, ...slotKeys(opts, "required")])) {
    errors.push(`:${key} is required`);
  }

  for (const slot of slots) {
    if (!entry(opts, slot)) errors.push(`unsupported :${slot} ${prStr(opts[slot])}`);
  }

  push(opts["provider-compute"] !== "digitalocean",
       ":provider-compute must be digitalocean");
  push(opts["provider-dns"] !== "cloudflare", ":provider-dns must be cloudflare");
  push(typeof opts["compute-prevent-destroy"] !== "boolean",
       ":compute-prevent-destroy must be true or false");
  push(typeof opts["cloudflare-proxied"] !== "boolean",
       ":cloudflare-proxied must be true or false");
  push(opts["cloudflare-proxied"] === true,
       ":cloudflare-proxied must be false; Cloudflare's proxy does not carry the PostgreSQL wire protocol");

  push(!(placeholder(opts.profile) || profileRe.test(String(opts.profile))),
       ":profile must be a safe 1-63 character name");

  push(opts["cluster-nodes"] !== utils.nodeCount,
       `:cluster-nodes must be ${utils.nodeCount}; the topology colocates a ` +
       "quorum store on the database nodes and cannot elect with fewer");

  push(String(opts["digitalocean-vpc-mode"]) !== "default",
       ":digitalocean-vpc-mode must be default; the regional default VPC is discovered at runtime");
  for (const key of forbiddenVpcKeys) {
    push(key in opts,
         `:${key} must not be configured; the regional default VPC is discovered at runtime`);
  }

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

  for (const key of ["digitalocean-ssh-sources", "digitalocean-client-sources"]) {
    const values = opts[key];
    push(!Array.isArray(values) || values.length === 0 ||
         values.some((value) => !validCidr(value)),
         `:${key} must be a non-empty list of IPv4 CIDRs`);
  }
  for (const key of ["digitalocean-ssh-sources", "digitalocean-client-sources"]) {
    const values = opts[key];
    push(Array.isArray(values) && values.some((value) => String(value) === "0.0.0.0/0"),
         `:${key} must not contain 0.0.0.0/0; administrative and database ingress stay scoped`);
  }

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

  return errors;
}

export function secretErrors(opts: Opts, selected: string[] = slots): string[] {
  const secretKeys = selected.flatMap((slot) => entry(opts, slot)?.secrets ?? []);
  return [...new Set(missing(opts, [...ownSecrets, ...secretKeys]))]
    .map((key) => `required credential is not set: ${parName(key)}`);
}
