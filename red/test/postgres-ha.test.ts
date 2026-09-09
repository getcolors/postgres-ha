// The port of green's five test namespaces: utils, validate, tools, operator,
// and workflow. One desired state, the shared fixture at the repository root.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parName } from "red/cli";
import { StepError, type Opts } from "red/workflow";
import {plan_deployment} from "colors-compute-red";
import * as compute from "../src/compute.ts";
import * as operator from "../src/operator.ts";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as utils from "../src/utils.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const fixture:Opts={...(Bun.YAML.parse(readFileSync(fixtureFile,"utf8")) as Opts),"provider-backend":"r2","red/event":"build"};
const optoutFile = join(import.meta.dir, "../../test/fixtures/optout.yml");
const optout:Opts={...(Bun.YAML.parse(readFileSync(optoutFile,"utf8")) as Opts),"provider-backend":"r2","red/event":"build","ssh-private-key-path":"/fixture/external"};

// --- utils -------------------------------------------------------------------

describe("utils", () => {
  const opts: Opts = { profile: "pg", "digitalocean-name": "postgres-ha" };

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

  test("both keypair modes are renderable", () => {
    // The SSH Keypair Standard has two modes and conformance means both hold.
    expect(validate.stateErrors(optout)).toEqual([]);
    expect(validate.keygen(fixture)).toBe(true);
    expect(validate.keygen(optout)).toBe(false);
    // The machine key is never required: its absence is keygen mode.
    expect(validate.stateErrors(fixture).some((e) => e.includes("digitalocean-ssh-keys"))).toBe(false);
  });

  test("the private key path is desired state in opt-out mode only", () => {
    const { "ssh-private-key-path": _o, "digitalocean-ssh-private-key": _legacy, ...withoutPath } = optout;
    expect(validate.stateErrors(withoutPath))
      .toContain(":ssh-private-key-path is required for external SSH access");
    const { "digitalocean-ssh-private-key": _k, ...keygenWithoutPath } = fixture;
    expect(validate.stateErrors(keygenWithoutPath)).toEqual([]);
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

  test("the node budget is fixed", () => {
    expect(has(errors({ "cluster-nodes": 2 }), /:cluster-nodes must be 3/)).toBe(true);
    expect(has(errors({ "cluster-nodes": 5 }), /:cluster-nodes must be 3/)).toBe(true);
    // a count that is not a positive integer is ONCE's to refuse too
    expect(has(errors({ "cluster-nodes": "3" }), /:cluster-nodes must be a positive integer/)).toBe(true);
  });

  test("only the providers this package implements are accepted", () => {
    expect(has(errors({ "provider-compute": "hcloud" }), /:hcloud-/)).toBe(true);
    expect(has(errors({ "provider-dns": "yandex" }), /unsupported :provider-dns/)).toBe(true);
    expect(has(errors({ "provider-backend": "gcs" }), /unsupported :provider-backend/)).toBe(true);
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

  test("ingress stays scoped",()=>{
    for(const key of ['digitalocean-ssh-sources','digitalocean-client-sources']){
     expect(errors({[key]:['0.0.0.0/0']}).some(e=>e.includes('must not contain'))).toBe(true);
     expect(errors({[key]:[]}).length).toBeGreaterThan(0);
     expect(errors({[key]:['10.0.0.1']}).length).toBeGreaterThan(0);
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
    for (const par of ["COLORS_PAR_CLOUDFLARE_API_TOKEN",
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

// A pre-adoption state exactly as `tofu output -json` parsed it: the four
// outputs, two parallel lists among them, and no `params`.
const legacyOutputs: Record<string, unknown> = {
  node_public_ips: ["203.0.113.1", "203.0.113.2", "203.0.113.3"],
  node_private_ips: ["10.20.0.1", "10.20.0.2", "10.20.0.3"],
  vpc_id: "5a6b7c8d-0000-4000-8000-000000000001",
  vpc_ip_range: "10.20.0.0/20",
};

// `params` as the adopted template records it, here through the legacy
// translation so the two shapes are provably one.
const recorded=():any=>({provider:'digitalocean',nodes:[0,1,2].map(i=>({provider:'digitalocean',node_id:String(i),index:i,role:null,name:'postgres-ha-fixture-'+i,ip:'203.0.113.'+(i+1),vpc_ip:'10.20.0.'+(i+1),user:'root',sudoer:'root'}))});

const without = (o: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

const converged = (): Opts => ({ ...fixture, "colors-compute/cluster": recorded(),"colors-compute/shared":{params:{network_cidr:"10.20.0.0/20"}},"ssh-private-key-path":"/fixture/owned" });

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
    // ONCE's fallbacks at offset 11 are the addresses this package always
    // rendered; documentation range, so a golden that leaked into a real run
    // points at nobody
    const ns = tools.nodes(fixture);
    expect(ns.length).toBe(3);
    expect(ns.map((n) => n["public-ip"])).toEqual(["192.0.2.10", "192.0.2.11", "192.0.2.12"]);
    expect(ns.map((n) => n["private-ip"])).toEqual(["10.0.0.10", "10.0.0.11", "10.0.0.12"]);
    expect(ns.map((n) => n.ordinal)).toEqual([1, 2, 3]);
    // the package's names, not ONCE's fallback rule
    expect(ns.map((n) => n.name))
      .toEqual(["postgres-ha-fixture-0", "postgres-ha-fixture-1", "postgres-ha-fixture-2"]);
    expect(tools.dataFn(fixture)["vpc-cidr"]).toBe("10.0.0.0/24");
    expect(tools.nodes(fixture)).toEqual(tools.nodes(fixture));
  });

  test("a real run reads every node from the adopted cluster", () => {
    const opts = converged();
    const ns = tools.nodes(opts);
    expect(ns.map((n) => n["public-ip"])).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    expect(ns.map((n) => n["private-ip"])).toEqual(["10.20.0.1", "10.20.0.2", "10.20.0.3"]);
    expect(ns.map((n) => n.ordinal)).toEqual([1, 2, 3]);
    expect(ns.map((n) => n.name))
      .toEqual(["postgres-ha-fixture-0", "postgres-ha-fixture-1", "postgres-ha-fixture-2"]);
    // the network facts beside the nodes come from state too
    expect(tools.dataFn(opts)["vpc-cidr"]).toBe("10.20.0.0/20");
    // and reach the inventory, the DNS records and the acceptance aliases
    const inv = JSON.parse(tools.inventory(opts));
    expect(inv.all.children.postgres.hosts["postgres-ha-fixture-1"].ansible_host).toBe("203.0.113.2");
    expect(((tools.dnsSpecs(opts)[0]!.data as Opts).nodes as tools.Node[]).map((n) => n["public-ip"]))
      .toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    expect(((tools.acceptanceSpecs(opts)[0]!.data as Opts).nodes as tools.Node[]).map((n) => n.alias))
      .toEqual(["postgres-ha-fixture-0", "postgres-ha-fixture-1", "postgres-ha-fixture-2"]);
  });

  test("the local play receives one block of aliases", () => {
    // ssh-config.md: the addresses and the aliases are extra-vars, never
    // rendered; the marker is the profile; the bare profile reaches node 0
    const vars = tools.ansibleLocalExtraVars({ ...converged(), "red/event": "create" });
    expect(vars.host_alias).toBe("postgres-ha-fixture");
    expect((vars.ssh_hosts as any[]).map(({name,ip})=>({name,ip}))).toEqual([
      { name: "postgres-ha-fixture", ip: "203.0.113.1" },
      { name: "postgres-ha-fixture-0", ip: "203.0.113.1" },
      { name: "postgres-ha-fixture-1", ip: "203.0.113.2" },
      { name: "postgres-ha-fixture-2", ip: "203.0.113.3" },
    ]);
    expect(vars.block_state).toBe("present");
    // The identity file is desired state a build knows and reaches the play
    // through Selmer, in keygen mode only.
    expect(Object.keys(vars).sort()).toEqual(["block_state", "host_alias", "ssh_hosts"]);
    const data = tools.ansibleLocalSpecs(fixture)[0]!.data as Opts;
    expect(data["ssh-keygen"]).toBe(true);
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/postgres-ha-fixture");
    expect((tools.ansibleLocalSpecs(optout)[0]!.data as Opts)["ssh-keygen"]).toBe(false);
    expect(tools.ansibleLocalExtraVars({ ...converged(), "red/event": "delete" }).block_state).toBe("absent");
    // a build renders the play without an address
    const rendered = readFileSync(join(import.meta.dir, "../resources/tools/ansible-local/main.yml"), "utf8");
    expect(rendered).toContain("begin = '# BEGIN ' + profile + ' ANSIBLE MANAGED BLOCK'");
    expect(rendered).toContain('fcntl.LOCK_EX');
    expect(rendered).toContain("for host in hosts:");
    expect(rendered).toContain("os.replace(temporary, path)");
    expect(/192\.0\.2|203\.0\.113/.test(rendered)).toBe(false);
  });

  test("the inventory carries exactly what the templates read", () => {
    const inv = JSON.parse(tools.inventory(converged()));
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
    // The nodes are reached with the generated key in keygen mode, on a build
    // through the placeholder, and with the operator's own key in opt-out mode.
    expect(JSON.parse(tools.inventory({ ...converged(), "red/event": "build" })).all.children.postgres.vars.ansible_ssh_private_key_file)
      .toBe("/home/build-placeholder/.ssh/postgres-ha-fixture");
    expect(JSON.parse(tools.inventory(optout)).all.children.postgres.vars.ansible_ssh_private_key_file)
      .toBe("/fixture/external");
  });

  test("derived values match what the tools actually accept", () => {
    const data = tools.dataFn(converged());
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
    expect(env.DIGITALOCEAN_TOKEN).toBeUndefined();
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
    // `--node 2` is the second node: ONCE's alias for index 1
    expect(argv.some((a) => a === "postgres-ha-fixture-1")).toBe(true);
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

const credentials = {
  COLORS_PAR_DO_TOKEN: "t", COLORS_PAR_CLOUDFLARE_API_TOKEN: "t",
  COLORS_PAR_R2_ACCESS_KEY_ID: "t", COLORS_PAR_R2_SECRET_ACCESS_KEY: "t",
  COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID: "t",
  COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY: "t",
  COLORS_PAR_POSTGRES_ADMIN_PASSWORD: "t",
  COLORS_PAR_POSTGRES_REPLICATION_PASSWORD: "t",
};
const unguarded = { ...credentials, COLORS_PAR_COMPUTE_PREVENT_DESTROY: "false" };

// `params` as a converged deployment records it.
const recordedParams = (): any => ({
  provider: "digitalocean",
  vpc_id: "5a6b7c8d-0000-4000-8000-000000000001",
  vpc_ip_range: "10.20.0.0/20",
  nodes: [0, 1, 2].map((i) => ({
    index: i, role: null, name: `postgres-ha-fixture-${i + 1}`,
    ip: `203.0.113.${i + 1}`, vpc_ip: `10.20.0.${i + 1}`, user: "root", sudoer: "root",
  })),
});

// The compute state is read once per run, through the injectable reader, on a
// real create or delete. Every lifecycle test injects one: undefined is a
// readable state holding no compute, a map is a recorded `params`, and a
// throw is a backend that cannot be read.
const start = (opts: Opts, env: Record<string, string | undefined>, state: any | undefined) =>
  workflow.startStep(opts, env);
// The shape `red/tofu` throws: the SDK's StepError. Only that is an unreadable
// backend; anything else propagates as a defect.
const startUnreadable = (opts: Opts, env: Record<string, string | undefined> = {}) =>
  workflow.startStep(opts, env);
const never = async (): Promise<undefined> => { throw new Error("the reader must not run"); };

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

  test("a build fills the placeholder key paths", async () => {
    // Every event fills the machine-key paths in preflight so the templates
    // and the inventory render the same whichever step scaffolds them; a build
    // gets the fixed placeholder, never the operator's home.
    const r = await workflow.startStep({ ...fixture, "red/event": "build" }, {});
    expect(r["red/exit"]).toBe(0);
    expect(r["ssh-private-key-path"]).toBe("/home/build-placeholder/.ssh/postgres-ha-fixture");
    expect(r["digitalocean-ssh-keys"]).toBeUndefined();
    // Opt-out invents no key path.
    const o = await workflow.startStep({ ...optout, "red/event": "build" }, {});
    expect(o["red/exit"]).toBe(0);
    expect(o["ssh-private-key-path"]).toBe("/fixture/external");
    expect(o["ssh-keygen"]).toBeUndefined();
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

  test("build and dry-run never read the state", async () => {
    // a throwing reader proves nothing on these paths reaches the backend
    for (const opts of [{ ...fixture, "red/event": "build" },
                        { ...fixture, "red/event": "create", "red/dry-run": true },
                        { ...fixture, "red/event": "delete", "red/dry-run": true }]) {
      const r = await workflow.startStep(opts, {});
      expect(r["red/exit"]).toBe(0);
      expect("postgres-ha/state" in r).toBe(false);
    }
  });

  test("a real create demands every credential", async () => {
    const result = await start({ ...fixture, "red/event": "create" }, {}, undefined);
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
    const guarded = await start({ ...fixture, "red/event": "delete" }, credentials, undefined);
    expect(guarded["red/exit"]).toBe(2);
    expect(String(guarded["red/err"])).toContain("compute destruction is protected");
    // and is lifted for exactly one run, from the environment, never by
    // editing the committed flag
    const lifted = await start({ ...fixture, "red/event": "delete" }, unguarded, undefined);
    expect(lifted["red/exit"]).toBe(0);
  });

  test("the profile overlay is refused", async () => {
    const result = await workflow.startStep(
      { ...fixture, "red/event": "build" }, { [parName("profile")]: "elsewhere" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("profile");
    // and the state is not read for a refused profile, nor for invalid
    // desired state
    const refused = await workflow.startStep(
      { ...fixture, "red/event": "delete" }, { ...unguarded, [parName("profile")]: "elsewhere" });
    expect(refused["red/exit"]).toBe(2);
    const invalid = await workflow.startStep(
      { ...fixture, "red/event": "delete", "cluster-nodes": 2 }, unguarded);
    expect(invalid["red/exit"]).toBe(2);
  });

  test("defaults describe a working cluster on their own", () => {
    // a deployment should only have to say what is specific to it
    expect(workflow.defaults["compute-prevent-destroy"]).toBe(true);
    expect(workflow.defaults["cluster-nodes"]).toBe(3);
    expect(workflow.defaults["patroni-synchronous-node-count"]).toBe(1);
    expect(workflow.defaults["cloudflare-proxied"]).toBe(false);
    expect(workflow.defaults["provider-backend"]).toBe("r2");
    expect(workflow.defaults["provider-compute"]).toBe("digitalocean");
  });

  // --- the Compute Cluster Standard's safety boundaries

  test("a real create on a fresh work directory reports the credentials, not a crash", async () => {
    // no reader stub: the real `stateOutput` runs against a work directory
    // that holds no stage yet, as a fresh clone's does. It renders the stage,
    // writes its backend and initializes it, and finds no state — or fails to
    // launch or initialize tofu, which the SDK reports as its StepError.
    // Either way ONCE's `readState` counts it as no usable state, so the
    // create reports its credentials instead of crashing
    const work = mkdtempSync(join(tmpdir(), "postgres-ha-red-fresh"));
    try {
      const result = await workflow.startStep({ ...fixture, workdir: work, "red/event": "create" }, {});
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"])).toContain("COLORS_PAR_POSTGRES_ADMIN_PASSWORD");
      expect(String(result["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

});

// --- the machine keypair -----------------------------------------------------

describe("ssh", () => {
  test("a build never names the operator's home", () => {
    // Committed goldens must mean the same thing on every workstation, so a
    // build renders a fixed placeholder rather than reading ~/.ssh.
    const opts = ssh.withMachineKey({ ...fixture, "red/event": "build" });
    expect(opts["ssh-private-key-path"]).toBe("/home/build-placeholder/.ssh/postgres-ha-fixture");
    expect(opts["ssh-public-key-path"]).toBe("/home/build-placeholder/.ssh/postgres-ha-fixture.pub");
    // The placeholder lands on the provider's own machine-key key.
    expect(opts["digitalocean-ssh-keys"]).toBeUndefined();
    expect(String(process.env.HOME)).not.toContain("build-placeholder");
  });

  test("a dry-run is held to the same rule as a build", () => {
    expect(ssh.renderedOnly({ "red/event": "build" })).toBe(true);
    expect(ssh.renderedOnly({ "red/event": "create", "red/dry-run": true })).toBe(true);
    expect(ssh.renderedOnly({ "red/event": "create" })).toBe(false);
    expect(ssh.withMachineKey({ ...fixture, "red/event": "create", "red/dry-run": true })["ssh-private-key-path"])
      .toBe("/home/build-placeholder/.ssh/postgres-ha-fixture");
  });

  test("opt-out opts pass through untouched", () => {
    const opts = { ...optout, "red/event": "build" };
    expect(ssh.withMachineKey(opts)).toEqual(opts);
    expect(ssh.withMachineKey(opts)["ssh-private-key-path"]).toBe("/fixture/external");
  });
});

// --- ~/.ssh/config -----------------------------------------------------------

describe("ssh-config", () => {
  const opts = { ...fixture, profile: "postgres-ha-digitalocean" };

  test("the deployment claims one alias per node and the bare profile", () => {
    expect(sshConfig.aliases(opts)).toEqual(
      ["postgres-ha-digitalocean", "postgres-ha-digitalocean-0", "postgres-ha-digitalocean-1", "postgres-ha-digitalocean-2"]);
  });

  test("the identity file stays unexpanded", () => {
    expect(sshConfig.identityFile(opts)).toBe("~/.ssh/postgres-ha-digitalocean");
  });

  test("a foreign stanza is found for any alias, not just the first", () => {
    const lines = "Host something\n  HostName 1.2.3.4\n\nHost postgres-ha-digitalocean-2\n  HostName 5.6.7.8\n"
      .split("\n");
    expect(sshConfig.foreignStanzaLine(lines, "postgres-ha-digitalocean")).toBeUndefined();
    expect(sshConfig.foreignStanzaLine(lines, "postgres-ha-digitalocean-2")).toBe(4);
  });

  test("our own managed block is not foreign for any alias in it", () => {
    const lines = [
      "# BEGIN postgres-ha-digitalocean ANSIBLE MANAGED BLOCK",
      "Host postgres-ha-digitalocean", "  HostName 1.2.3.4",
      "Host postgres-ha-digitalocean-0", "  HostName 1.2.3.4",
      "Host postgres-ha-digitalocean-1", "  HostName 1.2.3.5",
      "Host postgres-ha-digitalocean-2", "  HostName 1.2.3.6",
      "# END postgres-ha-digitalocean ANSIBLE MANAGED BLOCK",
    ];
    for (const alias of sshConfig.aliases(opts)) {
      expect(sshConfig.foreignStanzaLine(lines, alias, "postgres-ha-digitalocean")).toBeUndefined();
    }
  });

  test("a node stanza outside our block is still foreign", () => {
    const lines = [
      "# BEGIN postgres-ha-digitalocean ANSIBLE MANAGED BLOCK",
      "Host postgres-ha-digitalocean", "  HostName 1.2.3.4",
      "# END postgres-ha-digitalocean ANSIBLE MANAGED BLOCK",
      "Host postgres-ha-digitalocean-1", "  HostName 9.9.9.9",
    ];
    expect(sshConfig.foreignStanzaLine(lines, "postgres-ha-digitalocean-1", "postgres-ha-digitalocean")).toBe(5);
  });

  test("a global option above the first Host blocks the run", () => {
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host x"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# a comment", "", "Host x", "  User root"]))
      .toBeUndefined();
    expect(sshConfig.leadingOptionLine(["Host x", "  ServerAliveInterval 60"])).toBeUndefined();
  });

  test("the refusal is reported as a failed step", () => {
    const refused = sshConfig.preflight(opts, {
      adoptError: () => "no",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(refused["red/err"]).toBe("no");
    const passed = sshConfig.preflight(opts, {
      adoptError: () => undefined,
      placementError: () => undefined,
    });
    expect(passed["red/exit"]).toBeUndefined();
  });
});
