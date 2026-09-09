(ns io.github.getcolors.postgres-ha.compute
  "Application topology and network requirements for colors-compute."
  (:require [io.github.getcolors.compute :as compute]
            [io.github.getcolors.compute-deployment-request :as deployment]
            [io.github.getcolors.compute-planning :as planning]))
(defn topology [opts] [{:role nil :count (get opts :cluster-nodes 3)}])
(defn requirements [opts]
  (let [ssh (deployment/source-cidrs opts "ssh-sources" "postgres-ssh-sources")
        clients (deployment/source-cidrs opts "client-sources" "postgres-client-sources")]
    {:security {:ingress (into [{:id "ssh" :protocol "tcp" :from_port 22 :to_port 22 :sources ssh}]
                              (concat (map (fn [[id port]] {:id id :protocol "tcp" :from_port port :to_port port :sources clients})
                                           [["primary" (get opts :haproxy-primary-port 5432)] ["replica" (get opts :haproxy-replica-port 5433)]])
                                      (map (fn [protocol] {:id (str "private-" protocol) :protocol protocol :from_port 1 :to_port 65535 :sources ["private"]}) ["tcp" "udp"])
                                      [{:id "ping" :protocol "icmp" :from_port nil :to_port nil :sources (conj ssh "private")}]))
                :egress "all" :private_filter true}
     :private true :legacy_state_keys [(str (:profile opts) "/postgres-ha-infrastructure.tfstate")]}))
(defn resolved [opts]
  (if-let [recorded (:colors-compute/cluster opts)]
    (let [declarations (if (= :delete (:green/event opts)) (:nodes recorded) (compute/expand (topology opts)))
          requests (mapv #(assoc % :private true :provider (:provider-compute opts)) declarations)]
      (:nodes (compute/collect requests (:nodes recorded) (:node_id (first requests)))))
    (if (or (= :build (:green/event opts)) (:green/dry-run opts))
      (get-in (planning/plan-deployment opts (topology opts) (requirements opts)) [:cluster :nodes])
      (throw (ex-info "compute inventory unavailable" {})))))
