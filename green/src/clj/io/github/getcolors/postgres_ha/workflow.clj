(ns io.github.getcolors.postgres-ha.workflow
  "The lifecycle graph, the preflight, and the per-stage remote-state advice.

  Create is strictly sequential. The stages are not independent: DNS needs the
  addresses compute produced, the cluster play needs the inventory those
  addresses build, and acceptance needs a converged cluster *and* a resolvable
  name. Fanning any of it out would only buy back the seconds that DigitalOcean
  spends creating three droplets in one `apply` anyway.

  Delete runs the same edges backwards, with one addition: it adopts the
  cluster out of remote state first, because the local SSH configuration it
  has to withdraw is keyed by the nodes and by then the droplets may already
  be gone. The state is read once, in preflight, so the Compute Provider
  Standard's switch guard runs before the credentials are checked; the read is
  handed to `load-infrastructure` rather than repeated."
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.workflow :as wf]
            [io.github.getcolors.compute-inspection :as inspection]
            [io.github.getcolors.postgres-ha.ssh :as ssh]
            [io.github.getcolors.postgres-ha.ssh-config :as ssh-config]
            [io.github.getcolors.postgres-ha.tools :as tools]
            [io.github.getcolors.postgres-ha.validate :as validate]))

(def defaults
  {:provider-compute validate/default-compute-provider
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
   :client-connect-timeout-seconds 5
   :backup-stanza "main"
   :backup-retention-full 4
   :backup-r2-region "auto"
   :restore-check-port 5442
   :restore-check-max-age-hours 26
   :restore-check-max-lag-seconds 900
   :heartbeat-oncalendar "*:0/1"
   :heartbeat-retention-days 7})

(def lifecycle-events #{:create :delete})

(defn- real-lifecycle-event? [{:keys [event real?]}]
  (boolean (and real? (lifecycle-events event))))

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env] (start-step opts env nil))
  ([opts env _]
   (lifecycle/preflight opts
     {:defaults defaults :overlay green-cli/read-pars
      :validators [(fn [_ env _] (validate/env-errors env))
                   (fn [opts _ _] (validate/state-errors opts))
                   (fn [opts _ ctx]
                     (when (and (real-lifecycle-event? ctx) (empty? (validate/state-errors opts))) (validate/secret-errors opts)))
                   (fn [opts _ {:keys [event real?]}]
                     (when (and real? (= :delete event) (:compute-prevent-destroy opts))
                       ["compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false for this one delete"]))]
      :after-validate (fn [opts _ {:keys [event real?]}]
                        (if (and real? (= :create event)) (ssh-config/preflight! opts)
                            (assoc (ssh/with-machine-key opts) :green/exit 0)))} env)))

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
      ;; The keypair goes after the compute destroy (ssh-keypair.md §3.3): a
      ;; key that predeceases its hosts locks the operator out of nodes that
      ;; still exist.
      :postgres-ha/infrastructure [tools/infrastructure-step :postgres-ha/generated-cleanup]
      :postgres-ha/generated-cleanup [tools/generated-cleanup-step])
    (case step
      :postgres-ha/start [start-step :postgres-ha/infrastructure]
      :postgres-ha/infrastructure [tools/infrastructure-step :postgres-ha/dns]
      :postgres-ha/dns [tools/dns-step :postgres-ha/ansible-local]
      :postgres-ha/ansible-local [tools/ansible-local-step :postgres-ha/cluster]
      :postgres-ha/cluster [tools/cluster-step :postgres-ha/acceptance]
      :postgres-ha/acceptance [tools/acceptance-step])))

(defn backend-advice
  "The state backend of one OpenTofu stage: `tools/backend-advice`, which the
  state reader also runs, so a delete from a fresh clone finds its state."
  [tool]
  (tools/backend-advice tool))

(def side-effecting-steps
  [:postgres-ha/load-infrastructure :postgres-ha/infrastructure
   :postgres-ha/dns :postgres-ha/ansible-local :postgres-ha/cluster
   :postgres-ha/acceptance :postgres-ha/ssh-cleanup :postgres-ha/generated-cleanup])

(def workflow
  (-> (wf/workflow {:start :postgres-ha/start :wire-fn wire-fn
                    :next-fn (fn [_ successors opts]
                               (if (or (:postgres-ha/already-destroyed opts) (wf/failed? opts)) []
                                   (mapv #(vector % opts) successors)))})
      (wf/advice-add :postgres-ha/dns :before ::backend
                     (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting-steps)))
