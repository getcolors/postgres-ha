// Launcher contract and deterministic topology helpers, the port of
// io.github.getcolors.postgres-ha.utils.
//
// Everything here is a pure function of desired state. The topology is derived
// rather than configured: three nodes with stable ordinals, stable Ansible
// aliases, and stable droplet names, so an OpenTofu address and an inventory
// host name never move because a list was reordered.

import type { Opts } from "red/workflow";

// Minimum library contract a copied launcher requires. Bumped when the
// launcher and library must move together.
export const contract = 1;

// The only supported cluster size. Three is what makes a quorum store
// colocatable and a quorum-commit standby set meaningful; two cannot elect and
// four is outside the authorized machine budget.
export const nodeCount = 3;

// 1..nodeCount. The one place the node range is produced.
export function ordinals(): number[] {
  return Array.from({ length: nodeCount }, (_, i) => i + 1);
}

export function baseName(opts: Opts): string {
  const name = String(opts["digitalocean-name"] ?? "");
  return name.length ? name : "postgres-ha";
}

// The droplet name for ordinal `n`, also the Ansible inventory host name and
// the Patroni member name. One string for all three keeps `patronictl list`,
// `tofu state list` and the inventory mutually greppable.
export function nodeName(opts: Opts, n: number): string {
  return `${baseName(opts)}-${n}`;
}

export function profileAlias(opts: Opts): string {
  const profile = String(opts.profile ?? "");
  return profile.length ? profile : "postgres-ha";
}

// The `~/.ssh/config` Host entry the operator commands use for ordinal `n`.
export function sshAlias(opts: Opts, n: number): string {
  return `${profileAlias(opts)}-${n}`;
}

// The Ansible expression that reads a credential at play time.
//
// Rendered into generated files instead of the value, so a secret reaches a
// host through the process environment and never through a file on disk here.
export function parLookup(key: string): string {
  return `{{ lookup('env','COLORS_PAR_${key.replaceAll("-", "_").toUpperCase()}') }}`;
}

// The S3 endpoint host pgBackRest wants: it takes a bare host, not a URL.
export function endpointHost(endpoint: unknown): string {
  return String(endpoint ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

// pgBackRest's repository path is absolute inside the bucket.
export function repoPath(prefix: unknown): string {
  const p = String(prefix ?? "").replace(/^\/+/, "");
  return p.trim().length === 0 ? "/" : `/${p}`;
}
