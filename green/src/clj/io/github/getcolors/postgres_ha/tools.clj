(ns io.github.getcolors.postgres-ha.tools
  "Application stages fed by the shared compute library."
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.providers :as provider-ops]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.postgres-ha.compute :as compute]
            [io.github.getcolors.compute-orchestration :as orchestration]
            [io.github.getcolors.compute-planning :as planning]
            [io.github.getcolors.compute-inspection :as inspection]
            [io.github.getcolors.postgres-ha.ssh :as ssh]
            [io.github.getcolors.postgres-ha.ssh-config :as ssh-config]
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

(defn- cluster-nodes [opts] (compute/resolved opts))
(defn ssh-alias [opts n] (str (:profile opts) "-" (dec n)))
(defn nodes [opts]
  (mapv (fn [{:keys [index name ip vpc_ip user]}]
          {:ordinal (inc index) :name name :alias (ssh-alias opts (inc index)) :public-ip ip :private-ip vpc_ip :user user})
        (cluster-nodes opts)))
(defn private-key-file [opts] (or (:ssh-private-key-path opts) ""))

(defn- compute-json [value indent]
  (let [padding #(apply str (repeat % " "))]
    (cond
      (map? value) (if (empty? value) "{}"
                      (str "{\n" (str/join ",\n" (for [[key item] (sort-by key value)]
                                                       (str (padding (+ indent 2)) (json/generate-string key) ": " (compute-json item (+ indent 2)))))
                           "\n" (padding indent) "}"))
      (sequential? value) (if (empty? value) "[]"
                              (str "[\n" (str/join ",\n" (map #(str (padding (+ indent 2)) (compute-json % (+ indent 2))) value)) "\n" (padding indent) "]"))
      :else (json/generate-string value))))

(defn infrastructure-step [opts]
  (try
    (let [planning? (or (= :build (:green/event opts)) (:green/dry-run opts))
          result (if planning?
                   (planning/plan-deployment opts (compute/topology opts) (compute/requirements opts))
                   (orchestration/orchestrate opts (compute/topology opts) (compute/requirements opts)))]
      (when planning?
        (doseq [[stage documents] (cons ["shared" (get-in result [:documents :shared])]
                                      (map (fn [[id documents]] [(str "nodes/" id) documents]) (get-in result [:documents :nodes])))
                [filename document] documents]
          (let [target (io/file (tool-dir opts infrastructure-tool) stage filename)]
            (io/make-parents target)
            (spit target (str (compute-json document 0) "\n")))))
      (if-not (contains? #{"ready" "planned" "destroyed"} (:status result))
        (assoc opts :green/exit 1 :green/err "compute lifecycle refused; legacy monolithic state requires explicit migration")
        (cond-> (assoc opts :green/exit 0)
          (:cluster result) (assoc :colors-compute/cluster (:cluster result) :colors-compute/shared (:shared result))
          (get-in result [:key :private_key_path])
          (assoc :ssh-private-key-path (if planning? (str/replace (get-in result [:key :private_key_path]) "$HOME/.ssh" "/home/build-placeholder/.ssh") (get-in result [:key :private_key_path]))))))
    (catch Exception _ (assoc opts :green/exit 1 :green/err "compute lifecycle refused; legacy monolithic state requires explicit migration"))))

(defn load-infrastructure-step [opts]
  (if (or (= :build (:green/event opts)) (:green/dry-run opts)) (infrastructure-step opts)
      (let [result (inspection/read-deployment opts)]
        (case (:status result)
          "destroyed" (assoc opts :postgres-ha/already-destroyed true :green/exit 0)
          "present" (cond-> (assoc opts :colors-compute/cluster (:cluster result) :colors-compute/shared (:shared result) :postgres-ha/infrastructure-present? true :green/exit 0)
                      (get-in result [:key :private_key_path]) (assoc :ssh-private-key-path (get-in result [:key :private_key_path])))
          (refuse opts ["compute state unavailable; legacy monolithic state requires explicit migration"])))))

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
  "Template data: the topology, the adopted cluster's `vpc_ip_range` winning
  over the fallback on a real run, and the machine-key paths keygen mode
  owns."
  [opts]
  (let [opts (ssh/with-machine-key opts)
        ns (nodes opts)
        shared (or (:colors-compute/shared opts)
                   (when (or (= :build (:green/event opts)) (:green/dry-run opts))
                     (:shared (planning/plan-deployment opts (compute/topology opts) (compute/requirements opts)))))
        facts (:params shared)
        _ (when-not (:network_cidr facts) (throw (ex-info "compute shared network CIDR unavailable" {})))]
    (assoc opts
           :nodes ns
           :first-node (first ns)
           :vpc-cidr (:network_cidr facts)
           :ssh-private-key (private-key-file opts)
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

(defn ansible-local-data
  "Only what a `build` genuinely knows. Addresses are run-time facts and reach
  the play as extra-vars instead, so the rendered playbook carries no IP and
  is identical on every workstation (SSH Config Standard §6)."
  [opts]
  (assoc (data-fn opts)
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (if (validate/keygen? opts) (ssh-config/identity-file opts) (or (:ssh-private-key-path opts) ""))
         :host-alias (ssh-config/host-alias opts)))

(defn ansible-local-specs
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        data (ansible-local-data opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ssh-config-hosts
  "The `~/.ssh/config` entries, as data the play loops over: the bare profile
  pointing at node 0 (the spec's entry), then one alias per node. ONCE's
  (Compute Cluster Standard §6)."
  [opts]
  (let [nodes (cluster-nodes opts)]
    (into [(assoc (first nodes) :name (:profile opts))] (map #(assoc % :name (str (:profile opts) "-" (:index %))) nodes))))

(defn ansible-local-extra-vars
  "What the play cannot know from a `build`: the aliases and addresses,
  which are run-time facts and stay out of the rendered playbook so the
  committed goldens carry no address (ssh-config.md §6), and `block_state`
  — `present` on create, `absent` on delete — because the same playbook file
  serves both events. The identity file is desired state a build does know
  and reaches the play through Selmer instead."
  [opts]
  {:host_alias (ssh-config/host-alias opts)
   :ssh_hosts (ssh-config-hosts opts)
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
                    (map (fn [{:keys [name public-ip private-ip ordinal user]}]
                           [name {:ansible_host public-ip
                                  :ansible_user (or user "root")
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
