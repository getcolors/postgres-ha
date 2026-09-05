(ns io.github.getcolors.postgres-ha.tools
  "The five stages: DigitalOcean infrastructure, Cloudflare DNS, local SSH
  configuration, the remote cluster convergence, and acceptance.

  Every stage renders into `.colors/<profile>/<stage>/` and, for the OpenTofu
  ones, keys its remote state at `<profile>/<stage>.tfstate`. Those two names
  are the deployment's identity; changing either orphans live infrastructure,
  so they are constants here and asserted by the golden suite.

  The cluster itself — which machines exist, at which addresses — is the
  Compute Cluster Standard's `params`, adopted through ONCE's
  `compute-cluster` namespace and carried under `:once/cluster`. This
  package puts its own facts inside it: `vpc_id` and `vpc_ip_range` at the
  top level."
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.providers :as provider-ops]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.postgres-ha.utils :as utils]
            [io.github.getcolors.postgres-ha.validate :as validate]))

(def infrastructure-tool "postgres-ha-infrastructure")
(def dns-tool "postgres-ha-dns")
(def ansible-local-tool "postgres-ha-ansible-local")
(def cluster-tool "postgres-ha-cluster")
(def acceptance-tool "postgres-ha-acceptance")
(def tofu-tools [infrastructure-tool dns-tool])

(def ^:private root "io.github.getcolors.postgres-ha.tools")
(def ^:private template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool]
  (green-cli/stage-dir opts tool {:default-profile "postgres-ha"}))
(defn template [path file] (keyword (str root "." path) file))
(defn spec [template target data]
  {:template template :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))

(defn credential-env
  [opts & slots]
  (provider-ops/tool-env validate/providers opts
                         (conj (vec slots) :provider-backend)))

(defn backend-credential-env [opts] (credential-env opts))

(defn backend-advice
  "The state backend of one OpenTofu stage, written before the stage runs.
  `dir-fn` and `key-fn` are explicit so the state addresses cannot move."
  [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(defn- refuse [opts errors]
  (assoc opts :green/exit 1 :green/err (str/join "\n" errors)))

;; ---------------------------------------------------------------------------
;; Placeholder topology
;;
;; `build` renders the whole tree without contacting a provider, so it needs
;; values that are obviously not real. The nodes are ONCE's fallbacks — RFC
;; 5737 TEST-NET-1 public addresses and RFC 1918 private ones cut from
;; `spec`'s subnet at offset 11 — and the network facts beside them are the
;; stand-ins below. A golden file that leaked into a real run fails loudly
;; rather than pointing at somebody's host, and `bb golden` stays a pure
;; function of colors.yml.

(def fallback-outputs
  {:vpc_id "00000000-0000-0000-0000-000000000000"
   :vpc_ip_range "10.114.0.0/20"})

(defn- cluster-nodes
  "ONCE's nodes for this deployment: the adopted `params.nodes` on a real run,
  the fallbacks on a build — renamed to what this package has always called
  its nodes, `<name>-<ordinal>`, so the rendered inventory is byte-identical
  to what it was."
  [opts]
  (let [params (:once/cluster opts)
        nodes (cluster/nodes validate/spec opts params)]
    (if (some? params)
      nodes
      (mapv (fn [{:keys [index] :as node}]
              (assoc node :name (utils/node-name opts (inc index))))
            nodes))))

(defn ssh-alias
  "The `~/.ssh/config` Host entry the operator commands use for ordinal `n`:
  ONCE's `<profile>-<index>`, the Compute Cluster Standard's alias for the
  node at 0-based `index`. ONCE's list opens with the bare profile, so the
  1-based ordinal is also the position of its node's alias."
  [opts n]
  (nth (cluster/aliases validate/spec opts) n))

(defn nodes
  "The rendered topology: one map per ordinal over the node ONCE reports —
  the adopted cluster on a real run, the placeholders before the
  infrastructure stage has run. Pure: given the same opts it is the same
  vector, which is what makes the inventory and the goldens deterministic."
  [opts]
  (mapv (fn [{:keys [index name ip vpc_ip]}]
          (let [ordinal (inc index)]
            {:ordinal ordinal
             :name name
             :alias (ssh-alias opts ordinal)
             :public-ip ip
             :private-ip vpc_ip}))
        (cluster-nodes opts)))

;; ---------------------------------------------------------------------------
;; Stage 1 — infrastructure

(defn infrastructure-data
  [opts]
  (assoc opts
         :node-names-hcl (tofu/hcl-list (map #(utils/node-name opts %) (utils/ordinals)))
         :ssh-keys-hcl (tofu/hcl-list (compute/cidrs opts :digitalocean-ssh-keys))
         :ssh-sources-hcl (tofu/hcl-list (compute/cidrs opts :digitalocean-ssh-sources))
         :client-sources-hcl (tofu/hcl-list (compute/cidrs opts :digitalocean-client-sources))))

(defn infrastructure-specs
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)]
    [(spec (template "infrastructure" "main.tf") (str dir "/main.tf")
           (infrastructure-data opts))]))

(defn output-params
  "The compute stage's `params` output, as ONCE reads it: keywordized, the
  underscores kept; nil when the apply reported none."
  [result]
  (cluster/output-params {:tofu/outputs (:postgres-ha/outputs result)}))

(defn- non-blank? [v] (and (string? v) (not (str/blank? v))))

(defn params-errors
  "The extension keys this package puts inside `params`, which ONCE preserves
  but does not read: a non-blank `vpc_id` and a canonical `vpc_ip_range`, the
  network every etcd, Patroni and firewall rule is scoped to. A real run is
  refused without them; the legacy translation is held to the same rule."
  [params]
  (vec
   (concat
    (when-not (non-blank? (:vpc_id params))
      ["compute state carries no vpc_id"])
    (cond
      (not (non-blank? (:vpc_ip_range params)))
      ["compute state carries no vpc_ip_range"]
      (not (cluster/ipv4-network (:vpc_ip_range params)))
      [(str "compute state vpc_ip_range " (pr-str (:vpc_ip_range params))
            " is not a canonical IPv4 network such as 10.40.0.0/24")]))))

(defn- checked
  "`opts` once the adopted cluster passes `params-errors`, or the refusal."
  [opts]
  (let [errors (some-> (:once/cluster opts) params-errors)]
    (if (seq errors) (refuse opts errors) opts)))

(defn resolve-infrastructure
  "What the infrastructure stage hands on after its apply: `result` as it is
  on a failure, a delete or a build, and otherwise ONCE's `resolved-cluster`
  over the apply's `params` output — nil outputs and a partial cluster are
  refused there — checked against `params-errors`. Pure, so the wiring is
  testable without an apply."
  [opts result]
  (cond
    (wf/failed? result) result
    (contains? #{:delete :build} (:green/event opts)) result
    :else (let [resolved (cluster/resolved-cluster validate/spec opts result {}
                                                   (output-params result))]
            (if (wf/failed? resolved) resolved (checked resolved)))))

(defn infrastructure-step
  [opts]
  (resolve-infrastructure
   opts
   (tofu/tofu-with-spec opts (infrastructure-specs opts)
                        {:dir (tool-dir opts infrastructure-tool)
                         :env (credential-env opts :provider-compute)
                         :output-key :postgres-ha/outputs})))

(defn- step-error [dir label {:keys [out err]}]
  (ex-info (str label " failed: " (or (not-empty err) (not-empty out) "(no output)"))
           {:dir dir}))

(defn legacy-params
  "A state written before this package recorded `params`: the parallel
  `node_public_ips` and `node_private_ips` lists, zipped into the nodes the
  standard describes, with `vpc_id` and `vpc_ip_range` copied and the names
  this package has always given its nodes. Refused, as the SDK's step error
  carrying `dir`, when the two lists disagree with each other or with
  `cluster-nodes` — guessing which droplet is which is how a delete destroys
  around a node — and when no `vpc_id` or `vpc_ip_range` was recorded. The
  range's form is `params-errors`' to check, the same way for a legacy and a
  recorded state."
  [opts outputs dir]
  (let [publics (vec (:node_public_ips outputs))
        privates (vec (:node_private_ips outputs))
        n (:cluster-nodes opts)]
    (when-not (= n (count publics) (count privates))
      (throw (ex-info (str "legacy state lists " (count publics) " public addresses and "
                           (count privates) " private addresses; refusing to guess the cluster")
                      {:dir dir})))
    (doseq [k [:vpc_id :vpc_ip_range]]
      (when-not (non-blank? (get outputs k))
        (throw (ex-info (str "legacy state carries no " (name k)) {:dir dir}))))
    {:provider validate/default-compute-provider
     :vpc_id (:vpc_id outputs)
     :vpc_ip_range (:vpc_ip_range outputs)
     :nodes (mapv (fn [i]
                    {:index i
                     :role nil
                     :name (utils/node-name opts (inc i))
                     :ip (nth publics i)
                     :vpc_ip (nth privates i)
                     :user "root"
                     :sudoer "root"})
                  (range n))}))

(defn state-output
  "The reader ONCE's `read-state` takes: the compute `params` recorded in the
  infrastructure state, nil when the state is readable and holds nothing, and
  the legacy translation when it holds only the pre-adoption outputs. Delete
  needs the cluster before it destroys anything — the local SSH configuration
  is keyed by it — and a `plan` at that moment would be a second chance to
  change infrastructure on the way to removing it; nor can a fresh clone
  re-derive it, so the stage is rendered, its backend written and initialized
  here, before the read. A failed initialization throws the SDK's step error
  carrying `:dir`, the shape `green.tofu/outputs` throws on an unreadable
  backend; `read-state` reports both fail-closed."
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        credentials (credential-env opts :provider-compute)
        ;; `tofu/outputs` hands its map straight to the process as the whole
        ;; environment, so it needs the inherited one merged in; `process/run`
        ;; adds to the inherited environment and must not be given it twice.
        env (merge (into {} (System/getenv)) credentials)]
    (sc/scaffold (assoc opts :green/event :build) (infrastructure-specs opts))
    ((backend-advice infrastructure-tool) opts)
    (let [init (process/run ["tofu" (str "-chdir=" dir) "init" "-input=false" "-no-color"]
                            {:extra-env credentials})]
      (when-not (zero? (:exit init))
        (throw (step-error dir "infrastructure state initialization" init))))
    (let [outputs (tofu/outputs dir env)]
      (cond
        (contains? outputs :params) (walk/keywordize-keys (:params outputs))
        (empty? outputs) nil
        :else (legacy-params opts outputs dir)))))

(defn load-infrastructure-step
  "Adopt the cluster out of remote state without planning or mutating cloud
  resources: ONCE's `adopt-state` over the read `start-step` handed on under
  `:postgres-ha/state`, or a fresh read when nothing was. An unreadable
  backend and a partial cluster fail closed; the adopted `params` must then
  pass `params-errors`. A readable state without a cluster means there is
  nothing to clean up on a delete."
  [opts]
  (let [event (:green/event opts)
        state (or (:postgres-ha/state opts) (cluster/read-state opts state-output))
        adopted (cluster/adopt-state validate/spec (dissoc opts :postgres-ha/state) event state)
        present? (contains? adopted :once/cluster)]
    (if (wf/failed? adopted)
      adopted
      (let [checked (checked adopted)]
        (if (wf/failed? checked)
          checked
          (assoc checked :postgres-ha/infrastructure-present? present?))))))

;; ---------------------------------------------------------------------------
;; Stage 2 — DNS
;;
;; One A record per node, all carrying `cluster-host`. libpq resolves the name
;; and tries every address it gets back, so a node that is down is skipped by
;; the client itself: the endpoint survives a failover without any DNS write,
;; and nothing has to hold a cloud API credential at the moment the cluster is
;; degraded. See plans/0001 for the alternative that was rejected.

(defn dns-data
  [opts]
  (assoc opts :nodes (nodes opts)))

(defn dns-specs
  [opts]
  (let [dir (tool-dir opts dns-tool)]
    [(spec (template "dns" "main.tf") (str dir "/main.tf") (dns-data opts))]))

(defn dns-step
  [opts]
  (tofu/tofu-with-spec opts (dns-specs opts)
                       {:dir (tool-dir opts dns-tool)
                        :env (credential-env opts :provider-dns)
                        :output-key :postgres-ha/dns-outputs}))

;; ---------------------------------------------------------------------------
;; Shared render data

(defn data-fn
  "Template data: the topology, and the adopted cluster's `vpc_ip_range`
  winning over the fallback on a real run."
  [opts]
  (let [ns (nodes opts)
        facts (merge fallback-outputs
                     (select-keys (:once/cluster opts) (keys fallback-outputs)))]
    (assoc opts
           :nodes ns
           :first-node (first ns)
           :vpc-cidr (:vpc_ip_range facts)
           :ssh-private-key (str (:digitalocean-ssh-private-key opts))
           :backup-r2-s3-endpoint (utils/endpoint-host (:backup-r2-endpoint opts))
           :backup-repo-path (utils/repo-path (:backup-r2-prefix opts))
           :etcd-tarball (str "etcd-" (:etcd-version opts) "-linux-amd64.tar.gz")
           :etcd-url (str "https://github.com/etcd-io/etcd/releases/download/"
                          (:etcd-version opts) "/etcd-" (:etcd-version opts)
                          "-linux-amd64.tar.gz")
           :postgres-data-dir (str "/var/lib/postgresql/" (:postgres-version opts) "/main")
           :postgres-bin-dir (str "/usr/lib/postgresql/" (:postgres-version opts) "/bin")
           :admin-password-lookup (utils/par-lookup :postgres-admin-password)
           :replication-password-lookup (utils/par-lookup :postgres-replication-password)
           :backup-key-lookup (utils/par-lookup :backup-r2-access-key-id)
           :backup-secret-lookup (utils/par-lookup :backup-r2-secret-access-key))))

;; ---------------------------------------------------------------------------
;; Stage 3 — local SSH configuration

(defn ansible-local-specs
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        data (data-fn opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ssh-config-hosts
  "The `~/.ssh/config` entries, as data the play loops over: the bare profile
  pointing at node 0 (the spec's entry), then one alias per node. ONCE's
  (Compute Cluster Standard §6)."
  [opts]
  (cluster/ssh-config-hosts validate/spec opts (cluster-nodes opts)))

(defn legacy-aliases
  "The per-node aliases this package wrote before it adopted the SSH Config
  Standard's one block — `<profile>-<ordinal>`, 1-based, each under its own
  package-prefixed marker. The play removes those blocks (ssh-config.md §8: a
  marker change is a migration) for one pin cycle; then this goes."
  [opts]
  (mapv #(str (:profile opts) "-" %) (utils/ordinals)))

(defn ansible-local-extra-vars
  "What the play cannot know from a `build`: the aliases and addresses,
  which are run-time facts and stay out of the rendered playbook so the
  committed goldens carry no address (ssh-config.md §6), and `block_state`
  — `present` on create, `absent` on delete — because the same playbook file
  serves both events."
  [opts]
  {:host_alias (str (:profile opts))
   :ssh_hosts (ssh-config-hosts opts)
   :legacy_aliases (legacy-aliases opts)
   :ssh_private_key (str (:digitalocean-ssh-private-key opts))
   :block_state (if (= :delete (:green/event opts)) "absent" "present")})

(defn ansible-local-step
  [opts]
  (ansible/ansible-with-spec
   opts
   {:dir (tool-dir opts ansible-local-tool)
    :inventory "inventory.ini"
    :playbooks {:create "main.yml" :delete "main.yml"}
    :extra-vars (ansible-local-extra-vars opts)}
   (ansible-local-specs opts)))

;; ---------------------------------------------------------------------------
;; Stage 4 — the cluster itself

(defn inventory
  "A JSON inventory rather than INI: the per-host facts the templates need are
  structured, and `private_ip` in particular is what every generated etcd,
  Patroni and HAProxy stanza is built from."
  [opts]
  (let [data (data-fn opts)
        hosts (into (sorted-map)
                    (map (fn [{:keys [name public-ip private-ip ordinal]}]
                           [name {:ansible_host public-ip
                                  :ansible_user "root"
                                  :private_ip private-ip
                                  :node_ordinal ordinal}]))
                    (:nodes data))]
    (json/generate-string
     {:all {:children
            {:postgres {:hosts hosts
                        :vars {:ansible_ssh_private_key_file (:ssh-private-key data)}}}}}
     {:pretty true})))

(def scheduled-work-templates
  "The scripts and units that carry the backup, PITR-continuity and
  verified-restore schedule. All three pairs are installed on all three nodes;
  each asks Patroni what it is before doing anything, so the schedule follows
  the leader lock instead of a node name."
  ["postgres-ha-heartbeat" "postgres-ha-heartbeat.service"
   "postgres-ha-heartbeat.timer"
   "postgres-ha-backup" "postgres-ha-backup.service" "postgres-ha-backup.timer"
   "postgres-ha-restore-check" "postgres-ha-restore-check.service"
   "postgres-ha-restore-check.timer"])

(defn cluster-specs
  [opts]
  (let [dir (tool-dir opts cluster-tool)
        data (data-fn opts)]
    (concat
     [(spec (template "ansible-remote" "ansible.cfg") (str dir "/ansible.cfg") data)
      (spec (template "ansible-remote" "main.yml") (str dir "/main.yml") data)
      (spec (template "ansible-remote" "cleanup.yml") (str dir "/cleanup.yml") data)
      (spec (template "ansible-remote" "etcd.conf.yml.j2")
            (str dir "/templates/etcd.conf.yml.j2") data)
      (spec (template "ansible-remote" "etcd.service.j2")
            (str dir "/templates/etcd.service.j2") data)
      (spec (template "ansible-remote" "patroni.yml.j2")
            (str dir "/templates/patroni.yml.j2") data)
      (spec (template "ansible-remote" "patroni.service.j2")
            (str dir "/templates/patroni.service.j2") data)
      (spec (template "ansible-remote" "haproxy.cfg.j2")
            (str dir "/templates/haproxy.cfg.j2") data)
      (spec (template "ansible-remote" "pgbackrest.conf.j2")
            (str dir "/templates/pgbackrest.conf.j2") data)
      (raw-spec (str dir "/inventory.json") (inventory opts))]
     ;; The nine scheduled-work files are listed once, here, because the
     ;; playbook loops over the same names when it installs them. Two lists
     ;; that had to be kept in step by hand is how a unit ends up rendered but
     ;; never enabled.
     (for [unit scheduled-work-templates]
       (spec (template "ansible-remote" (str unit ".j2"))
             (str dir "/templates/" unit ".j2") data)))))

(defn cluster-step
  [opts]
  (if (and (= :delete (:green/event opts))
           (false? (:postgres-ha/infrastructure-present? opts)))
    (sc/scaffold opts (cluster-specs opts))
    (ansible/ansible-with-spec
     opts
     {:dir (tool-dir opts cluster-tool)
      :inventory "inventory.json"
      :playbooks {:create "main.yml" :delete "cleanup.yml"}
      :host-key-checking false
      :recap-key :postgres-ha/cluster-recap}
     (cluster-specs opts))))

;; ---------------------------------------------------------------------------
;; Stage 5 — acceptance

(defn acceptance-specs
  [opts]
  (let [dir (tool-dir opts acceptance-tool)]
    [(spec (template "acceptance" "acceptance.sh")
           (str dir "/acceptance.sh") (data-fn opts))]))

(defn process-result
  [opts label {:keys [exit out err]}]
  (if (zero? exit)
    (assoc opts :green/exit 0)
    (assoc opts :green/exit (max 1 exit)
           :green/err (str label " failed: "
                           (or (not-empty err) (not-empty out) "(no output)")))))

(defn acceptance-env
  "The credential the acceptance script authenticates with, taken from opts
  rather than read again from the ambient environment so a `COLORS_PAR_*`
  overlay and a desired-state value cannot disagree. `:extra-env` is added to
  the inherited environment, so nothing else has to be repeated here."
  [opts]
  {"PGPASSWORD" (str (:postgres-admin-password opts))})

(defn acceptance-step
  [opts]
  (let [rendered (sc/scaffold opts (acceptance-specs opts))]
    (if (not= :create (:green/event opts))
      rendered
      (let [result (process/run-with-timeout
                    ["bash" (str (tool-dir opts acceptance-tool) "/acceptance.sh")]
                    {:extra-env (acceptance-env opts)}
                    (* 20 60 1000))]
        ;; The script's own transcript is the evidence a health check produced.
        ;; Printing it on success as well as failure is the difference between
        ;; "acceptance passed" and knowing which eight things it asserted.
        (when-let [out (not-empty (str (:out result)))] (println out))
        (process-result rendered "acceptance" result)))))

(defn generated-cleanup-step
  [opts]
  (-> opts
      (sc/scaffold (ansible-local-specs opts))
      (sc/scaffold (acceptance-specs opts))))
