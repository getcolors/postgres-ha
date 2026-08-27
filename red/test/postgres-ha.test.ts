// The port of green's five test namespaces: utils, validate, tools, operator,
// and workflow. One desired state, the shared fixture at the repository root.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import * as operator from "../src/operator.ts";
import * as tools from "../src/tools.ts";
import * as utils from "../src/utils.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const fixture = Bun.YAML.parse(readFileSync(fixtureFile, "utf8")) as Opts;

// --- utils -------------------------------------------------------------------

describe("utils", () => {
  const opts: Opts = { profile: "pg", "digitalocean-name": "postgres-ha" };

  test("topology is derived not configured", () => {
    expect(utils.ordinals()).toEqual([1, 2, 3]);
    expect(utils.nodeCount).toBe(3);
    expect(utils.ordinals().map((n) => utils.nodeName(opts, n)))
      .toEqual(["postgres-ha-1", "postgres-ha-2", "postgres-ha-3"]);
    expect(utils.ordinals().map((n) => utils.sshAlias(opts, n)))
      .toEqual(["pg-1", "pg-2", "pg-3"]);
  });

  test("names fall back rather than rendering nil", () => {
    // a half-populated desired state still renders reviewable names
    expect(utils.nodeName({}, 1)).toBe("postgres-ha-1");
    expect(utils.sshAlias({}, 1)).toBe("postgres-ha-1");
    expect(utils.nodeName({ "digitalocean-name": "" }, 1)).toBe("postgres-ha-1");
  });

  test("par lookup names the shared credential namespace", () => {
    expect(utils.parLookup("postgres-admin-password"))
      .toBe("{{ lookup('env','COLORS_PAR_POSTGRES_ADMIN_PASSWORD') }}");
    // it renders the expression, never a value
    expect(utils.parLookup("backup-r2-secret-access-key"))
      .not.toMatch(/secret|password=/);
  });

  test("endpoint host strips what pgBackRest will not take", () => {
    // pgBackRest wants a bare host, and an https:// prefix makes it fail
    // with a DNS error that names a host containing a slash
    expect(utils.endpointHost("https://account.r2.cloudflarestorage.com"))
      .toBe("account.r2.cloudflarestorage.com");
    expect(utils.endpointHost("https://account.r2.cloudflarestorage.com/"))
      .toBe("account.r2.cloudflarestorage.com");
    expect(utils.endpointHost("account.r2.cloudflarestorage.com"))
      .toBe("account.r2.cloudflarestorage.com");
  });

  test("repo path is absolute inside the bucket", () => {
    expect(utils.repoPath("postgres-ha-digitalocean")).toBe("/postgres-ha-digitalocean");
    expect(utils.repoPath("/postgres-ha-digitalocean")).toBe("/postgres-ha-digitalocean");
    expect(utils.repoPath("")).toBe("/");
  });
});

// --- validate ----------------------------------------------------------------

const errors = (overrides: Opts) => validate.stateErrors({ ...fixture, ...overrides });
const has = (messages: string[], re: RegExp) => messages.some((m) => re.test(m));

describe("validate", () => {
  test("the fixture is renderable", () => {
    // the golden fixture must stay valid, or the golden proves nothing
    expect(validate.stateErrors(fixture)).toEqual([]);
  });

  test("every problem is reported at once", () => {
    // a person fixing desired state one error per run gives up on it
    const messages = errors({
      "cluster-host": null, "postgres-database": "Not An Ident",
      "backup-retention-full": 0, "etcd-sha256": "nope",
    });
    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(has(messages, /:cluster-host is required/)).toBe(true);
    expect(has(messages, /postgres-database must be an unquoted lowercase SQL identifier/)).toBe(true);
    expect(has(messages, /backup-retention-full must be a positive integer/)).toBe(true);
    expect(has(messages, /etcd-sha256 must be the lowercase hex SHA-256/)).toBe(true);
  });

  test("the profile overlay is refused", () => {
    expect(validate.envErrors({})).toBeUndefined();
    expect(validate.envErrors({ [validate.profilePar]: "" })).toBeUndefined();
    expect(has(validate.envErrors({ [validate.profilePar]: "somebody-elses-deployment" })!,
               /takes profile from colors\.yml only/)).toBe(true);
  });

  test("the VPC is discovered and cannot be described", () => {
    // accepting a VPC identifier would let one deployment be edited onto
    // another's private network while passing every other check
    for (const key of validate.forbiddenVpcKeys) {
      expect(has(errors({ [key]: "10.0.0.0/16" }),
                 /must not be configured; the regional default VPC is discovered/))
        .toBe(true);
    }
    expect(has(errors({ "digitalocean-vpc-mode": "explicit" }),
               /:digitalocean-vpc-mode must be default/)).toBe(true);
  });

  test("the node budget is fixed", () => {
    expect(has(errors({ "cluster-nodes": 2 }), /:cluster-nodes must be 3/)).toBe(true);
    expect(has(errors({ "cluster-nodes": 5 }), /:cluster-nodes must be 3/)).toBe(true);
  });

  test("ports that share an address must differ", () => {
    // the primary listener deliberately reuses the PostgreSQL port, because
    // HAProxy binds the public address and PostgreSQL the private one
    expect(errors({ "haproxy-primary-port": 5432, "postgres-port": 5432 })).toEqual([]);
    expect(has(errors({ "haproxy-replica-port": 5432 }),
               /:haproxy-replica-port must differ from :postgres-port/)).toBe(true);
    expect(has(errors({ "etcd-client-port": 8008 }), /port 8008 is claimed by/)).toBe(true);
    expect(has(errors({ "restore-check-port": 7000 }), /port 7000 is claimed by/)).toBe(true);
  });

  test("quorum settings cannot describe a cluster that stalls", () => {
    // requiring every standby to acknowledge leaves a three-node cluster
    // that cannot tolerate losing one, which is the whole point of it
    expect(has(errors({ "patroni-synchronous-node-count": 3 }),
               /:patroni-synchronous-node-count must be between 1 and 2/)).toBe(true);
    expect(has(errors({ "patroni-synchronous-node-count": 0 }),
               /:patroni-synchronous-node-count/)).toBe(true);
    // two is defensible — a stricter durability bar the cluster can still
    // degrade from — so it is allowed rather than legislated against
    expect(errors({ "patroni-synchronous-node-count": 2 })).toEqual([]);
    // a TTL that can expire between two health checks is a cluster that
    // fails over because nothing went wrong
    expect(has(errors({ "patroni-ttl": 15, "patroni-loop-wait": 10 }),
               /:patroni-ttl must exceed twice :patroni-loop-wait/)).toBe(true);
  });

  test("the endpoint must be reachable as PostgreSQL", () => {
    expect(has(errors({ "cloudflare-proxied": true }),
               /Cloudflare's proxy does not carry the PostgreSQL wire protocol/)).toBe(true);
    expect(has(errors({ "cluster-host": "pg-ha.somewhere.else" }),
               /:cluster-host must be inside :cloudflare-zone/)).toBe(true);
    expect(has(errors({ "cloudflare-record-ttl": 30 }),
               /:cloudflare-record-ttl must be 1 \(automatic\) or between 60 and 86400/)).toBe(true);
  });

  test("the client connect timeout is desired state not folklore", () => {
    // the endpoint resolves to every node, so a client can try an address
    // whose machine is powered off — which black-holes rather than refuses,
    // and without a bound libpq waits out the OS TCP retry
    expect(has(errors({ "client-connect-timeout-seconds": 0 }),
               /:client-connect-timeout-seconds must be between 1 and 30/)).toBe(true);
    expect(has(errors({ "client-connect-timeout-seconds": 120 }),
               /:client-connect-timeout-seconds must be between 1 and 30/)).toBe(true);
    expect(has(errors({ "client-connect-timeout-seconds": null }),
               /:client-connect-timeout-seconds/)).toBe(true);
    expect(errors({ "client-connect-timeout-seconds": 5 })).toEqual([]);
  });

  test("ingress stays scoped", () => {
    for (const key of ["digitalocean-ssh-sources", "digitalocean-client-sources"]) {
      expect(has(errors({ [key]: ["0.0.0.0/0"] }), /must not contain 0\.0\.0\.0\/0/)).toBe(true);
      expect(has(errors({ [key]: [] }), /must be a non-empty list of IPv4 CIDRs/)).toBe(true);
      expect(has(errors({ [key]: ["203.0.113.10"] }),
                 /must be a non-empty list of IPv4 CIDRs/)).toBe(true);
    }
  });

  test("blast radius is separated", () => {
    expect(has(errors({ "backup-r2-bucket": fixture["r2-bucket"] }),
               /must not be the OpenTofu state bucket/)).toBe(true);
  });

  test("versions are pinned precisely enough to reproduce", () => {
    expect(has(errors({ "patroni-package-version": "4.1.5" }),
               /must be a full Debian package version/)).toBe(true);
    expect(has(errors({ "pgbackrest-package-version": "latest" }),
               /must be a full Debian package version/)).toBe(true);
    expect(has(errors({ "etcd-version": "3.5.33" }),
               /:etcd-version must be an exact vX\.Y\.Z/)).toBe(true);
    expect(has(errors({ "haproxy-version": "2.8.5" }),
               /:haproxy-version must be a distribution major\.minor/)).toBe(true);
  });

  test("the restore-check tolerance cannot be set below what archiving allows", () => {
    expect(has(errors({ "restore-check-max-lag-seconds": 30 }),
               /:restore-check-max-lag-seconds must exceed 120/)).toBe(true);
  });

  test("credentials are demanded by name", () => {
    const messages = validate.secretErrors(fixture);
    // with none set, every one is named once
    expect(messages.length).toBe(new Set(messages).size);
    for (const par of ["COLORS_PAR_DO_TOKEN", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                       "COLORS_PAR_R2_ACCESS_KEY_ID", "COLORS_PAR_R2_SECRET_ACCESS_KEY",
                       "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID",
                       "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY",
                       "COLORS_PAR_POSTGRES_ADMIN_PASSWORD",
                       "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD"]) {
      expect(has(messages, new RegExp(par))).toBe(true);
    }
    // and a supplied one stops being demanded
    expect(has(validate.secretErrors({ ...fixture, "do-token": "t" }),
               /COLORS_PAR_DO_TOKEN\b/)).toBe(false);
  });

  test("no message can contain a credential", () => {
    const loaded = {
      ...fixture, "do-token": "tok-do", "cloudflare-api-token": "tok-cf",
      "postgres-admin-password": "hunter2", "backup-r2-secret-access-key": "sekrit",
    };
    const messages = [...validate.stateErrors(loaded), ...validate.secretErrors(loaded)];
    for (const secret of ["tok-do", "tok-cf", "hunter2", "sekrit"]) {
      expect(messages.some((m) => m.includes(secret))).toBe(false);
    }
  });
});

// --- tools -------------------------------------------------------------------

const converged: Opts = {
  ...fixture,
  node_public_ips: ["203.0.113.1", "203.0.113.2", "203.0.113.3"],
  node_private_ips: ["10.20.0.1", "10.20.0.2", "10.20.0.3"],
  vpc_ip_range: "10.20.0.0/20",
};

describe("tools", () => {
  test("stage directories and state keys are the deployment identity", () => {
    // these two strings address live infrastructure; moving either orphans a
    // cluster, so they are asserted rather than derived at the call site
    expect(tools.toolDir(fixture, tools.infrastructureTool))
      .toEndWith(".colors/postgres-ha-fixture/postgres-ha-infrastructure");
    expect(tools.tofuTools).toEqual(["postgres-ha-infrastructure", "postgres-ha-dns"]);
    expect(tools.clusterTool).toBe("postgres-ha-cluster");
    expect(tools.ansibleLocalTool).toBe("postgres-ha-ansible-local");
    expect(tools.acceptanceTool).toBe("postgres-ha-acceptance");
  });

  test("a build renders placeholder addresses not real ones", () => {
    const ns = tools.nodes(fixture);
    expect(ns.length).toBe(3);
    // TEST-NET-1, so a golden that leaked into a real run points at nobody
    expect(ns.every((n) => n["public-ip"].startsWith("192.0.2."))).toBe(true);
    expect(ns.map((n) => n.name))
      .toEqual(["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]);
  });

  test("converged addresses replace the placeholders in ordinal order", () => {
    const ns = tools.nodes(converged);
    expect(ns.map((n) => n["public-ip"])).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    expect(ns.map((n) => n["private-ip"])).toEqual(["10.20.0.1", "10.20.0.2", "10.20.0.3"]);
    expect(ns.map((n) => n.ordinal)).toEqual([1, 2, 3]);
  });

  test("the inventory carries exactly what the templates read", () => {
    const inv = JSON.parse(tools.inventory(converged));
    const hosts = inv.all.children.postgres.hosts as Record<string, Record<string, unknown>>;
    expect(Object.keys(hosts).length).toBe(3);
    // private_ip is what every etcd, Patroni and HAProxy stanza is built
    // from; a missing one renders a syntactically valid configuration for a
    // cluster that cannot form
    for (const host of Object.values(hosts)) {
      expect(host.private_ip).toBeDefined();
      expect(host.ansible_host).toBeDefined();
      expect(host.ansible_user).toBe("root");
    }
    expect(inv.all.children.postgres.vars.ansible_ssh_private_key_file)
      .toBe("~/.ssh/id_ed25519");
  });

  test("the HCL lists are quoted not interpolated", () => {
    const data = tools.infrastructureData(fixture);
    expect(data["node-names-hcl"])
      .toBe('["postgres-ha-fixture-1", "postgres-ha-fixture-2", "postgres-ha-fixture-3"]');
    expect(data["ssh-sources-hcl"]).toBe('["203.0.113.10/32"]');
    expect(data["ssh-keys-hcl"]).toBe('["12345678"]');
  });

  test("derived values match what the tools actually accept", () => {
    const data = tools.dataFn(converged);
    expect(data["backup-r2-s3-endpoint"]).toBe("account.r2.cloudflarestorage.com");
    expect(data["backup-repo-path"]).toBe("/postgres-ha-fixture");
    expect(data["postgres-data-dir"]).toBe("/var/lib/postgresql/17/main");
    expect(data["postgres-bin-dir"]).toBe("/usr/lib/postgresql/17/bin");
    expect(data["vpc-cidr"]).toBe("10.20.0.0/20");
    expect(data["etcd-url"])
      .toBe("https://github.com/etcd-io/etcd/releases/download/v3.5.33/etcd-v3.5.33-linux-amd64.tar.gz");
  });

  test("every scheduled unit is both rendered and installed", () => {
    // two hand-maintained lists is how a unit ends up rendered but never
    // enabled, so the playbook loops over the same names this renders
    const targets = new Set(tools.clusterSpecs(fixture).map((s) => s.target));
    const playbook = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible-remote/main.yml"), "utf8");
    for (const unit of tools.scheduledWorkTemplates) {
      expect([...targets].some((t) => t.endsWith(`/templates/${unit}.j2`))).toBe(true);
      expect(playbook.includes(`- ${unit}\n`)).toBe(true);
    }
  });

  test("the cluster stage renders a complete tree", () => {
    const targets = tools.clusterSpecs(fixture).map((s) => s.target);
    for (const expected of ["/main.yml", "/cleanup.yml", "/ansible.cfg", "/inventory.json",
                            "/templates/patroni.yml.j2", "/templates/etcd.conf.yml.j2",
                            "/templates/haproxy.cfg.j2", "/templates/pgbackrest.conf.j2"]) {
      expect(targets.some((t) => t.endsWith(expected))).toBe(true);
    }
  });

  test("the acceptance credential is taken from opts", () => {
    // reading the environment again here would let a COLORS_PAR_ overlay and
    // the value the workflow validated disagree
    expect(tools.acceptanceEnv({ ...fixture, "postgres-admin-password": "hunter2" }))
      .toEqual({ PGPASSWORD: "hunter2" });
  });

  test("tofu credentials reach the process and not the file", () => {
    const env = tools.credentialEnv(
      { ...fixture, "do-token": "tok", "r2-access-key-id": "ak",
        "r2-secret-access-key": "sk" },
      "provider-compute")!;
    expect(env.DIGITALOCEAN_TOKEN).toBe("tok");
    expect(env.AWS_ACCESS_KEY_ID).toBe("ak");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("sk");
    // an absent credential contributes no empty variable, which would look to
    // a provider like an explicit empty credential
    expect((tools.credentialEnv(fixture, "provider-compute") ?? {}).DIGITALOCEAN_TOKEN)
      .toBeUndefined();
  });
});

// --- operator ----------------------------------------------------------------

const stateFile = fixtureFile;

function capture(): [{ seen: string[] | null }, operator.Runner] {
  const box: { seen: string[] | null } = { seen: null };
  return [box, (argv: string[]) => {
    box.seen = argv;
    return { exit: 0 };
  }];
}

describe("operator", () => {
  test("node selection is explicit and bounded", () => {
    expect(operator.parseArgs([])).toEqual({ ordinal: 1, extra: [] });
    expect(operator.parseArgs(["--node", "2"])).toEqual({ ordinal: 2, extra: [] });
    expect(operator.parseArgs(["--node", "3", "--candidate", "x"]))
      .toEqual({ ordinal: 3, extra: ["--candidate", "x"] });
    expect(operator.parseArgs(["--", "--candidate", "x"]))
      .toEqual({ ordinal: 1, extra: ["--candidate", "x"] });
    expect(operator.parseArgs(["--node", "second"]).error).toBeDefined();
  });

  test("out-of-range nodes are refused before anything is dispatched", async () => {
    const [box, runner] = capture();
    const result = await operator.run(stateFile, "status", ["--node", "9"], runner, {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("--node must be between 1 and 3");
    // a refused invocation must not reach a host
    expect(box.seen).toBeNull();
  });

  test("operator verbs dispatch through the managed SSH alias", () => {
    // so the identity file and host-key policy are defined once, by the local
    // stage, rather than copied into every verb
    const argv = operator.command("status", fixture, 2, []);
    expect(argv[0]).toBe("ssh");
    expect(argv.some((a) => a.endsWith(".ssh/config"))).toBe(true);
    expect(argv.some((a) => a === "postgres-ha-fixture-2")).toBe(true);
    expect(argv[argv.length - 1]!).toContain("patronictl");
  });

  test("the verbs are the tools not a second opinion about the cluster", () => {
    expect(operator.remoteCommand("status", fixture, []))
      .toEqual(["patronictl", "-c", "/etc/patroni/patroni.yml", "list"]);
    expect(operator.remoteCommand("failover", fixture, []))
      .toEqual(["patronictl", "-c", "/etc/patroni/patroni.yml", "failover", "--force"]);
    expect(operator.remoteCommand("switchover", fixture, ["--candidate", "postgres-ha-fixture-3"]))
      .toEqual(["patronictl", "-c", "/etc/patroni/patroni.yml", "switchover", "--force",
                "--candidate", "postgres-ha-fixture-3"]);
    // backup and verify-restore run exactly what the timers run, so a manual
    // run cannot pass while the scheduled one is broken
    expect(operator.remoteCommand("backup", fixture, []))
      .toEqual(["/usr/local/bin/postgres-ha-backup"]);
    expect(operator.remoteCommand("verify-restore", fixture, []))
      .toEqual(["/usr/local/bin/postgres-ha-restore-check"]);
  });

  test("psql goes through HAProxy and never carries the password in argv", () => {
    const remote = operator.remoteCommand("psql", fixture, []);
    const argv = operator.command("psql", fixture, 1, []);
    expect(remote).toEqual(["psql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "appdb"]);
    // loopback HAProxy, not the local PostgreSQL: the node the operator
    // picked may be a standby, and a read-only session that looks like a
    // primary session is the worst possible answer
    expect(remote[2]).toBe("127.0.0.1");
    // psql needs a terminal for its password prompt
    expect(argv.some((a) => a === "-t")).toBe(true);
    expect(argv.some((a) => a.includes("PGPASSWORD"))).toBe(false);
  });

  test("the profile overlay is refused here too", async () => {
    const [box, runner] = capture();
    const result = await operator.run(stateFile, "status", [], runner,
                                      { [parName("profile")]: "elsewhere" });
    expect(result["red/exit"]).toBe(2);
    expect(box.seen).toBeNull();
  });

  test("an unknown verb prints usage rather than guessing", async () => {
    const [box, runner] = capture();
    const result = await operator.run(stateFile, "restart", [], runner, {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("Usage:");
    expect(box.seen).toBeNull();
  });

  test("a missing desired state file is a usage error", async () => {
    const result = await operator.run(
      join(import.meta.dir, "../../test/fixtures/absent.yml"), "status", [],
      capture()[1], {});
    expect(result["red/exit"]).toBe(2);
  });

  test("a failing command propagates a nonzero exit", async () => {
    const result = await operator.run(stateFile, "status", [],
                                      () => ({ exit: 3, err: "boom" }), {});
    expect(result["red/exit"]).toBe(3);
  });
});

// --- workflow ----------------------------------------------------------------

// Follow the static graph from postgres-ha/start for `event`.
function walk(event: string): string[] {
  let step = "postgres-ha/start";
  const seen: string[] = [];
  for (let guard = 0; ; guard += 1) {
    const decl = workflow.wireFn(step, { "red/event": event })!;
    const nexts = decl.slice(1) as string[];
    if (guard > 20) return [...seen, "loop"];
    if (nexts.length === 0) return [...seen, step];
    seen.push(step);
    step = nexts[0]!;
  }
}

describe("workflow", () => {
  test("create walks compute, dns, local, cluster, acceptance", () => {
    // strictly sequential: DNS needs the addresses compute produced, the
    // cluster play needs the inventory those addresses build, and acceptance
    // needs both a converged cluster and a resolvable name
    expect(walk("create")).toEqual([
      "postgres-ha/start", "postgres-ha/infrastructure", "postgres-ha/dns",
      "postgres-ha/ansible-local", "postgres-ha/cluster", "postgres-ha/acceptance",
    ]);
  });

  test("delete runs the same edges backwards after loading state", () => {
    // the local SSH configuration delete has to withdraw is keyed by
    // addresses that may already be gone, so they are read from remote state
    // before anything is destroyed
    expect(walk("delete")).toEqual([
      "postgres-ha/start", "postgres-ha/load-infrastructure",
      "postgres-ha/cluster", "postgres-ha/ansible-local", "postgres-ha/dns",
      "postgres-ha/infrastructure", "postgres-ha/generated-cleanup",
    ]);
  });

  test("build follows the create graph", () => {
    expect(walk("build")).toEqual(walk("create"));
  });

  test("every side-effecting step is skipped by dry-run", () => {
    // a step that reaches a provider and is not in this list makes --dry-run
    // a lie
    const effecting = new Set(workflow.sideEffectingSteps);
    for (const step of [...walk("create"), ...walk("delete")]) {
      if (step === "postgres-ha/start") continue;
      expect(effecting.has(step)).toBe(true);
    }
  });

  test("remote state keys are per-stage and profile-scoped", () => {
    const advice = workflow.backendAdvice(tools.infrastructureTool);
    const dir = mkdtempSync(join(tmpdir(), "postgres-ha-backend-"));
    const opts = { ...fixture, workdir: dir };
    advice(opts);
    const written = readFileSync(
      join(tools.toolDir(opts, tools.infrastructureTool), "backend.tf.json"), "utf8");
    expect(written).toContain("postgres-ha-fixture/postgres-ha-infrastructure.tfstate");
    expect(written).toContain("fixture-state");
    // R2 authenticates through the AWS environment chain; naming the keys in
    // the backend document would write them to disk
    expect(written).not.toContain("access_key");
    expect(written).not.toContain("secret_key");
  });

  test("a build needs no credential", async () => {
    // which is what makes build and --dry-run the safe way to review a
    // colors.yml edit on a fresh checkout
    const result = await workflow.startStep({ ...fixture, "red/event": "build" }, {});
    expect(result["red/exit"]).toBe(0);
  });

  test("a real create demands every credential", async () => {
    const result = await workflow.startStep({ ...fixture, "red/event": "create" }, {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_POSTGRES_ADMIN_PASSWORD");
    expect(String(result["red/err"])).toContain("COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY");
  });

  test("a dry-run create demands none", async () => {
    const result = await workflow.startStep(
      { ...fixture, "red/event": "create", "red/dry-run": true }, {});
    expect(result["red/exit"]).toBe(0);
  });

  test("destruction stays guarded", async () => {
    const credentials = {
      COLORS_PAR_DO_TOKEN: "t", COLORS_PAR_CLOUDFLARE_API_TOKEN: "t",
      COLORS_PAR_R2_ACCESS_KEY_ID: "t", COLORS_PAR_R2_SECRET_ACCESS_KEY: "t",
      COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID: "t",
      COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY: "t",
      COLORS_PAR_POSTGRES_ADMIN_PASSWORD: "t",
      COLORS_PAR_POSTGRES_REPLICATION_PASSWORD: "t",
    };
    const guarded = await workflow.startStep({ ...fixture, "red/event": "delete" }, credentials);
    expect(guarded["red/exit"]).toBe(2);
    expect(String(guarded["red/err"])).toContain("compute destruction is protected");
    // and is lifted for exactly one run, from the environment, never by
    // editing the committed flag
    const lifted = await workflow.startStep(
      { ...fixture, "red/event": "delete" },
      { ...credentials, COLORS_PAR_COMPUTE_PREVENT_DESTROY: "false" });
    expect(lifted["red/exit"]).toBe(0);
  });

  test("the profile overlay is refused", async () => {
    const result = await workflow.startStep(
      { ...fixture, "red/event": "build" }, { [parName("profile")]: "elsewhere" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("profile");
  });

  test("defaults describe a working cluster on their own", () => {
    // a deployment should only have to say what is specific to it
    expect(workflow.defaults["compute-prevent-destroy"]).toBe(true);
    expect(workflow.defaults["cluster-nodes"]).toBe(3);
    expect(workflow.defaults["patroni-synchronous-node-count"]).toBe(1);
    expect(workflow.defaults["cloudflare-proxied"]).toBe(false);
    expect(workflow.defaults["digitalocean-vpc-mode"]).toBe("default");
  });
});
