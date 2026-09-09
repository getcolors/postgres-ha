(ns io.github.getcolors.postgres-ha.tools-test
  (:require [cheshire.core :as json] [clojure.java.io :as io] [clojure.string :as str]
            [clojure.test :refer [deftest is testing]] [clojure.walk :as walk]
            [io.github.getcolors.postgres-ha.tools :as tools]
            [io.github.getcolors.postgres-ha.validate-test :as validation]))
(def base (assoc validation/base :green/event :build))
(def optout (assoc validation/optout :green/event :build))
(def recorded {:nodes (mapv (fn [i] {:node_id (str i) :index i :role nil :provider "digitalocean" :name (str "db-" i)
                                     :ip (str "203.0.113." (inc i)) :vpc_ip (str "10.20.0." (inc i)) :user "ubuntu" :sudoer "root"}) (range 3))})
(def converged (assoc base :green/event :create :colors-compute/cluster recorded :colors-compute/shared {:params {:provider "digitalocean" :network_cidr "10.20.0.0/20"}} :ssh-private-key-path "/tmp/owned"))
(deftest application-uses-library-node-and-network-facts
  (is (= [1 2 3] (mapv :ordinal (tools/nodes converged))))
  (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip (tools/nodes converged))))
  (is (= "10.20.0.0/20" (:vpc-cidr (tools/data-fn converged))))
  (is (= "ubuntu" (get-in (json/parse-string (tools/inventory converged) true) [:all :children :postgres :hosts :db-0 :ansible_user])))
  (is (thrown? Exception (tools/data-fn (dissoc converged :colors-compute/shared)))))
(deftest planning-is-deterministic-and-delete-retains-recorded-nodes
  (is (= (tools/nodes base) (tools/nodes base)))
  (is (= 3 (count (tools/nodes (assoc converged :green/event :delete :cluster-nodes 1))))))
(deftest dns-specs-test
  (testing "dns specs render"
    (let [specs (tools/dns-specs base)]
      (is (= 1 (count specs)))
      (is (= :io.github.getcolors.postgres-ha.tools.dns/main.tf
             (:template (first specs)))))))

(deftest cluster-specs-test
  (testing "cluster specs include all required templates"
    (let [specs (tools/cluster-specs base)
          templates (set (map :template specs))]
      (is (contains? templates :io.github.getcolors.postgres-ha.tools.ansible-remote/main.yml))
      (is (contains? templates :io.github.getcolors.postgres-ha.tools.ansible-remote/etcd.service.j2))
      (is (contains? templates :io.github.getcolors.postgres-ha.tools.ansible-remote/patroni.yml.j2))
      (is (contains? templates :io.github.getcolors.postgres-ha.tools.ansible-remote/haproxy.cfg.j2))
      (is (contains? templates :io.github.getcolors.postgres-ha.tools.ansible-remote/pgbackrest.conf.j2))
      (is (contains? templates :io.github.getcolors.postgres-ha.tools.ansible-remote/postgres-ha-heartbeat.service.j2))
      (is (contains? templates :io.github.getcolors.postgres-ha.tools.ansible-remote/postgres-ha-restore-check.service.j2)))))

(deftest derived-values-match-what-the-tools-actually-accept
  (let [data (tools/data-fn converged)]
    (is (= "account.r2.cloudflarestorage.com" (:backup-r2-s3-endpoint data)))
    (is (= "/postgres-ha-fixture" (:backup-repo-path data)))
    (is (= "/var/lib/postgresql/17/main" (:postgres-data-dir data)))
    (is (= "/usr/lib/postgresql/17/bin" (:postgres-bin-dir data)))
    (is (= "10.20.0.0/20" (:vpc-cidr data)))
    (is (= (str "https://github.com/etcd-io/etcd/releases/download/v3.5.33/"
                "etcd-v3.5.33-linux-amd64.tar.gz")
           (:etcd-url data)))))

(deftest every-scheduled-unit-is-both-rendered-and-installed
  (testing "two hand-maintained lists is how a unit ends up rendered but never
            enabled, so the playbook loops over the same names this renders"
    (let [targets (set (map :target (tools/cluster-specs base)))
          playbook (slurp (io/resource "io/github/getcolors/postgres-ha/tools/ansible-remote/main.yml"))]
      (doseq [unit tools/scheduled-work-templates]
        (is (some #(str/ends-with? % (str "/templates/" unit ".j2")) targets)
            (str unit " is not rendered"))
        (is (str/includes? playbook (str "- " unit "\n"))
            (str unit " is rendered but never installed"))))))

(deftest the-cluster-stage-renders-a-complete-tree
  (let [targets (map :target (tools/cluster-specs base))]
    (doseq [expected ["/main.yml" "/cleanup.yml" "/ansible.cfg" "/inventory.json"
                      "/templates/patroni.yml.j2" "/templates/etcd.conf.yml.j2"
                      "/templates/haproxy.cfg.j2" "/templates/pgbackrest.conf.j2"]]
      (is (some #(str/ends-with? % expected) targets) (str "missing " expected)))))

(deftest the-acceptance-credential-is-taken-from-opts
  (testing "reading the environment again here would let a COLORS_PAR_ overlay
            and the value the workflow validated disagree"
    (is (= {"PGPASSWORD" "hunter2"}
           (tools/acceptance-env (assoc base :postgres-admin-password "hunter2"))))))
