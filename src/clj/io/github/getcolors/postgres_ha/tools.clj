(ns io.github.getcolors.postgres-ha.tools
  "The five stages: DigitalOcean infrastructure, Cloudflare DNS, local SSH
  configuration, the remote cluster convergence, and acceptance.

  Every stage renders into `.colors/<profile>/<stage>/` and, for the OpenTofu
  ones, keys its remote state at `<profile>/<stage>.tfstate`. Those two names
  are the deployment's identity; changing either orphans live infrastructure,
  so they are constants here and asserted by the golden suite."
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

(defn cidrs
  [opts k]
  (let [v (get opts k)
        xs (if (sequential? v) v (str/split (str v) #"[,\s]+"))]
    (->> xs (map (comp str/trim str)) (remove str/blank?) vec)))

;; ---------------------------------------------------------------------------
;; Placeholder topology
;;
;; `build` renders the whole tree without contacting a provider, so it needs
;; addresses that are obviously not real. RFC 5737 TEST-NET-1 and RFC 1918
;; values make a golden file that leaks into a real run fail loudly rather than
;; point at somebody's host, and they keep `bb golden` a pure function of
;; colors.yml.

(def fallback-outputs
  {:vpc_id "00000000-0000-0000-0000-000000000000"
   :vpc_ip_range "10.114.0.0/20"
   :node_public_ips ["192.0.2.11" "192.0.2.12" "192.0.2.13"]
   :node_private_ips ["10.114.0.11" "10.114.0.12" "10.114.0.13"]})

(defn- output-map [result]
  (some-> (:postgres-ha/outputs result) walk/keywordize-keys))

(defn nodes
  "The rendered topology: one map per ordinal, joined with whatever addresses
  the infrastructure stage produced (or the placeholders, before it has run)."
  [opts]
  (let [public (vec (:node_public_ips opts (:node_public_ips fallback-outputs)))
        private (vec (:node_private_ips opts (:node_private_ips fallback-outputs)))]
    (mapv (fn [n]
            (let [i (dec n)]
              {:ordinal n
               :name (utils/node-name opts n)
               :alias (utils/ssh-alias opts n)
               :public-ip (get public i (get-in fallback-outputs [:node_public_ips i]))
               :private-ip (get private i (get-in fallback-outputs [:node_private_ips i]))}))
          (utils/ordinals))))

;; ---------------------------------------------------------------------------
;; Stage 1 — infrastructure

(defn infrastructure-data
  [opts]
  (assoc opts
         :node-names-hcl (tofu/hcl-list (map #(utils/node-name opts %) (utils/ordinals)))
         :ssh-keys-hcl (tofu/hcl-list (cidrs opts :digitalocean-ssh-keys))
         :ssh-sources-hcl (tofu/hcl-list (cidrs opts :digitalocean-ssh-sources))
         :client-sources-hcl (tofu/hcl-list (cidrs opts :digitalocean-client-sources))))

(defn infrastructure-specs
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)]
    [(spec (template "infrastructure" "main.tf") (str dir "/main.tf")
           (infrastructure-data opts))]))

(defn infrastructure-step
  [opts]
  (let [result (tofu/tofu-with-spec
                opts (infrastructure-specs opts)
                {:dir (tool-dir opts infrastructure-tool)
                 :env (credential-env opts :provider-compute)
                 :output-key :postgres-ha/outputs})]
    (cond
      (wf/failed? result) result
      (= :delete (:green/event opts)) result
      (= :build (:green/event opts)) (merge result fallback-outputs)
      :else (merge result fallback-outputs (output-map result)))))

(declare process-result)

(defn load-infrastructure-step
  "Read node addresses out of remote state without planning or mutating cloud
  resources.

  Delete needs the addresses before it destroys anything — the local SSH
  configuration is keyed by them — and a `plan` at that moment would be a
  second chance to change infrastructure on the way to removing it."
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        rendered (assoc (sc/scaffold (assoc opts :green/event :build)
                                     (infrastructure-specs opts))
                        :green/event (:green/event opts))
        credentials (credential-env opts :provider-compute)
        ;; `tofu/outputs` hands its map straight to the process as the whole
        ;; environment, so it needs the inherited one merged in; `process/run`
        ;; adds to the inherited environment and must not be given it twice.
        env (merge (into {} (System/getenv)) credentials)
        init (process/run ["tofu" (str "-chdir=" dir) "init" "-input=false" "-no-color"]
                          {:extra-env credentials})]
    (if-not (zero? (:exit init))
      (process-result rendered "infrastructure state initialization" init)
      (try
        (let [outputs (tofu/outputs dir env)]
          (merge rendered fallback-outputs outputs
                 {:postgres-ha/infrastructure-present?
                  (contains? outputs :node_public_ips)}))
        (catch Throwable t
          (assoc rendered :green/exit 1
                 :green/err (str "infrastructure state output failed: "
                                 (or (ex-message t) (str (class t))))))))))

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
  [opts]
  (let [ns (nodes opts)]
    (assoc opts
           :nodes ns
           :first-node (first ns)
           :vpc-cidr (or (:vpc_ip_range opts) (:vpc_ip_range fallback-outputs))
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

(defn ansible-local-step
  [opts]
  (let [data (data-fn opts)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec
     opts
     {:dir (tool-dir opts ansible-local-tool)
      :inventory "inventory.ini"
      :playbooks {:create "main.yml" :delete "main.yml"}
      :extra-vars {:block_state (if delete? "absent" "present")
                   :nodes (mapv #(select-keys % [:alias :public-ip :ordinal])
                                (:nodes data))
                   :ssh_private_key (:ssh-private-key data)}}
     (ansible-local-specs opts))))

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
