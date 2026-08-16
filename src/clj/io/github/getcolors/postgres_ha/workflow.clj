(ns io.github.getcolors.postgres-ha.workflow
  "The lifecycle graph, the preflight, and the per-stage remote-state advice.

  Create is strictly sequential. The stages are not independent: DNS needs the
  addresses compute produced, the cluster play needs the inventory those
  addresses build, and acceptance needs a converged cluster *and* a resolvable
  name. Fanning any of it out would only buy back the seconds that DigitalOcean
  spends creating three droplets in one `apply` anyway.

  Delete runs the same edges backwards, with one addition: it loads the node
  addresses out of remote state first, because the local SSH configuration it
  has to withdraw is keyed by them and by then the droplets may already be
  gone."
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.postgres-ha.tools :as tools]
            [io.github.getcolors.postgres-ha.validate :as validate]))

(def defaults
  {:provider-compute "digitalocean"
   :provider-dns "cloudflare"
   :provider-backend "local"
   :compute-prevent-destroy true
   :workdir ".colors"
   :cluster-nodes 3
   :cloudflare-proxied false
   :cloudflare-record-ttl 60
   :digitalocean-vpc-mode "default"
   :postgres-port 5432
   :postgres-admin-user "postgres"
   :postgres-replication-user "replicator"
   :patroni-rest-port 8008
   :patroni-ttl 30
   :patroni-loop-wait 10
   :patroni-retry-timeout 10
   :patroni-synchronous-node-count 1
   :etcd-client-port 2379
   :etcd-peer-port 2380
   :haproxy-primary-port 5432
   :haproxy-replica-port 5433
   :haproxy-stats-port 7000
   :backup-stanza "main"
   :backup-retention-full 4
   :backup-r2-region "auto"
   :restore-check-port 5442
   :restore-check-max-age-hours 26
   :restore-check-max-lag-seconds 900
   :heartbeat-oncalendar "*:0/1"
   :heartbeat-retention-days 7})

(def lifecycle-events #{:create :delete})

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts
    {:defaults defaults
     :overlay green-cli/read-pars
     :validators
     [(fn [_ env _] (validate/env-errors env))
      (fn [opts _ _] (validate/state-errors opts))
      ;; Credentials are only demanded by a run that will actually use them.
      ;; `build` and `--dry-run` therefore work on a fresh checkout with an
      ;; empty environment, which is what makes them a safe way to review a
      ;; colors.yml edit.
      (fn [opts _ {:keys [event real?]}]
        (when (and real? (lifecycle-events event)) (validate/secret-errors opts)))
      (fn [opts _ {:keys [event real?]}]
        (when (and real? (= :delete event) (:compute-prevent-destroy opts))
          [(str "compute destruction is protected; set "
                (green-cli/par-name :compute-prevent-destroy)
                "=false for this one delete")]))]}
    env)))

(defn wire-fn
  [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :postgres-ha/start [start-step :postgres-ha/load-infrastructure]
      :postgres-ha/load-infrastructure [tools/load-infrastructure-step
                                        :postgres-ha/cluster]
      :postgres-ha/cluster [tools/cluster-step :postgres-ha/ansible-local]
      :postgres-ha/ansible-local [tools/ansible-local-step :postgres-ha/dns]
      :postgres-ha/dns [tools/dns-step :postgres-ha/infrastructure]
      :postgres-ha/infrastructure [tools/infrastructure-step
                                   :postgres-ha/generated-cleanup]
      :postgres-ha/generated-cleanup [tools/generated-cleanup-step])
    (case step
      :postgres-ha/start [start-step :postgres-ha/infrastructure]
      :postgres-ha/infrastructure [tools/infrastructure-step :postgres-ha/dns]
      :postgres-ha/dns [tools/dns-step :postgres-ha/ansible-local]
      :postgres-ha/ansible-local [tools/ansible-local-step :postgres-ha/cluster]
      :postgres-ha/cluster [tools/cluster-step :postgres-ha/acceptance]
      :postgres-ha/acceptance [tools/acceptance-step])))

(defn backend-advice
  [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting-steps
  [:postgres-ha/load-infrastructure :postgres-ha/infrastructure
   :postgres-ha/dns :postgres-ha/ansible-local :postgres-ha/cluster
   :postgres-ha/acceptance :postgres-ha/generated-cleanup])

(def workflow
  (-> (wf/workflow {:start :postgres-ha/start :wire-fn wire-fn})
      (wf/advice-add :postgres-ha/load-infrastructure :before ::backend
                     (backend-advice tools/infrastructure-tool))
      (wf/advice-add :postgres-ha/infrastructure :before ::backend
                     (backend-advice tools/infrastructure-tool))
      (wf/advice-add :postgres-ha/dns :before ::backend
                     (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting-steps)))
