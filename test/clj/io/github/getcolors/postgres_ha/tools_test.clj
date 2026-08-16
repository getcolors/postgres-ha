(ns io.github.getcolors.postgres-ha.tools-test
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-ha.tools :as tools]))

(def fixture
  (let [file (io/file "test/fixtures/colors.yml")]
    (green-cli/read-state file (slurp file))))

(def converged
  (merge fixture
         {:node_public_ips ["203.0.113.1" "203.0.113.2" "203.0.113.3"]
          :node_private_ips ["10.20.0.1" "10.20.0.2" "10.20.0.3"]
          :vpc_ip_range "10.20.0.0/20"}))

(deftest stage-directories-and-state-keys-are-the-deployment-identity
  (testing "these two strings address live infrastructure; moving either
            orphans a cluster, so they are asserted rather than derived at
            the call site"
    (is (str/ends-with? (tools/tool-dir fixture tools/infrastructure-tool)
                        ".colors/postgres-ha-fixture/postgres-ha-infrastructure"))
    (is (= ["postgres-ha-infrastructure" "postgres-ha-dns"] tools/tofu-tools))
    (is (= "postgres-ha-cluster" tools/cluster-tool))
    (is (= "postgres-ha-ansible-local" tools/ansible-local-tool))
    (is (= "postgres-ha-acceptance" tools/acceptance-tool))))

(deftest a-build-renders-placeholder-addresses-not-real-ones
  (let [ns (tools/nodes fixture)]
    (is (= 3 (count ns)))
    (is (every? #(str/starts-with? (:public-ip %) "192.0.2.") ns)
        "TEST-NET-1, so a golden that leaked into a real run points at nobody")
    (is (= ["postgres-ha-fixture-1" "postgres-ha-fixture-2" "postgres-ha-fixture-3"]
           (mapv :name ns)))))

(deftest converged-addresses-replace-the-placeholders-in-ordinal-order
  (let [ns (tools/nodes converged)]
    (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip ns)))
    (is (= ["10.20.0.1" "10.20.0.2" "10.20.0.3"] (mapv :private-ip ns)))
    (is (= [1 2 3] (mapv :ordinal ns)))))

(deftest the-inventory-carries-exactly-what-the-templates-read
  (let [inv (json/parse-string (tools/inventory converged) true)
        hosts (get-in inv [:all :children :postgres :hosts])]
    (is (= 3 (count hosts)))
    (testing "private_ip is what every etcd, Patroni and HAProxy stanza is
              built from; a missing one renders a syntactically valid
              configuration for a cluster that cannot form"
      (doseq [[_ host] hosts]
        (is (some? (:private_ip host)))
        (is (some? (:ansible_host host)))
        (is (= "root" (:ansible_user host)))))
    (is (= "~/.ssh/id_ed25519"
           (get-in inv [:all :children :postgres :vars :ansible_ssh_private_key_file])))))

(deftest the-hcl-lists-are-quoted-not-interpolated
  (let [data (tools/infrastructure-data fixture)]
    (is (= "[\"postgres-ha-fixture-1\", \"postgres-ha-fixture-2\", \"postgres-ha-fixture-3\"]"
           (:node-names-hcl data)))
    (is (= "[\"203.0.113.10/32\"]" (:ssh-sources-hcl data)))
    (is (= "[\"12345678\"]" (:ssh-keys-hcl data)))))

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
    (let [targets (set (map :target (tools/cluster-specs fixture)))
          playbook (slurp (io/resource "io/github/getcolors/postgres-ha/tools/ansible-remote/main.yml"))]
      (doseq [unit tools/scheduled-work-templates]
        (is (some #(str/ends-with? % (str "/templates/" unit ".j2")) targets)
            (str unit " is not rendered"))
        (is (str/includes? playbook (str "- " unit "\n"))
            (str unit " is rendered but never installed"))))))

(deftest the-cluster-stage-renders-a-complete-tree
  (let [targets (map :target (tools/cluster-specs fixture))]
    (doseq [expected ["/main.yml" "/cleanup.yml" "/ansible.cfg" "/inventory.json"
                      "/templates/patroni.yml.j2" "/templates/etcd.conf.yml.j2"
                      "/templates/haproxy.cfg.j2" "/templates/pgbackrest.conf.j2"]]
      (is (some #(str/ends-with? % expected) targets) (str "missing " expected)))))

(deftest the-acceptance-credential-is-taken-from-opts
  (testing "reading the environment again here would let a COLORS_PAR_ overlay
            and the value the workflow validated disagree"
    (is (= {"PGPASSWORD" "hunter2"}
           (tools/acceptance-env (assoc fixture :postgres-admin-password "hunter2"))))))

(deftest tofu-credentials-reach-the-process-and-not-the-file
  (let [env (tools/credential-env (merge fixture {:do-token "tok"
                                                  :r2-access-key-id "ak"
                                                  :r2-secret-access-key "sk"})
                                  :provider-compute)]
    (is (= "tok" (get env "DIGITALOCEAN_TOKEN")))
    (is (= "ak" (get env "AWS_ACCESS_KEY_ID")))
    (is (= "sk" (get env "AWS_SECRET_ACCESS_KEY")))
    (testing "an absent credential contributes no empty variable, which would
              look to a provider like an explicit empty credential"
      (is (nil? (get (tools/credential-env fixture :provider-compute)
                     "DIGITALOCEAN_TOKEN"))))))
