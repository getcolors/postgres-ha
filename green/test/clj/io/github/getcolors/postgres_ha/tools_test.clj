(ns io.github.getcolors.postgres-ha.tools-test
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [clojure.walk :as walk]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.postgres-ha.tools :as tools]
            [io.github.getcolors.postgres-ha.validate :as validate]))

(def fixture
  (let [file (io/file "test/fixtures/colors.yml")]
    (green-cli/read-state file (slurp file))))

(def legacy-outputs
  "A pre-adoption state exactly as `tofu output -json` parsed it: the four
  outputs, two parallel lists among them, and no `params`."
  {:node_public_ips ["203.0.113.1" "203.0.113.2" "203.0.113.3"]
   :node_private_ips ["10.20.0.1" "10.20.0.2" "10.20.0.3"]
   :vpc_id "5a6b7c8d-0000-4000-8000-000000000001"
   :vpc_ip_range "10.20.0.0/20"})

(def recorded
  "`params` as the adopted template records it, here through the legacy
  translation so the two shapes are provably one."
  (tools/legacy-params fixture legacy-outputs "x"))

(def converged (assoc fixture :once/cluster recorded))

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
  ;; ONCE's fallbacks at offset 11 are the addresses this package always
  ;; rendered; documentation range, so a golden that leaked into a real run
  ;; points at nobody.
  (let [ns (tools/nodes fixture)]
    (is (= 3 (count ns)))
    (is (= ["192.0.2.11" "192.0.2.12" "192.0.2.13"] (mapv :public-ip ns)))
    (is (= ["10.114.0.11" "10.114.0.12" "10.114.0.13"] (mapv :private-ip ns)))
    (is (= [1 2 3] (mapv :ordinal ns)))
    (is (= ["postgres-ha-fixture-1" "postgres-ha-fixture-2" "postgres-ha-fixture-3"]
           (mapv :name ns))
        "the package's names, not ONCE's fallback rule")
    (is (= "10.114.0.0/20" (:vpc-cidr (tools/data-fn fixture))))
    (is (= (tools/nodes fixture) (tools/nodes fixture)))))

(deftest the-aliases-are-the-standards
  ;; Compute Cluster Standard §6: the bare profile reaches node 0, then
  ;; `<profile>-<index>`; `--node N` is 1-based and lands on index N-1.
  (is (= ["postgres-ha-fixture-0" "postgres-ha-fixture-1" "postgres-ha-fixture-2"]
         (mapv :alias (tools/nodes fixture))))
  (is (= "postgres-ha-fixture-0" (tools/ssh-alias fixture 1)))
  (is (= "postgres-ha-fixture-2" (tools/ssh-alias fixture 3)))
  (is (= (rest (cluster/aliases validate/spec fixture)) (map :alias (tools/nodes fixture)))))

(deftest a-real-run-reads-every-node-from-the-adopted-cluster
  (let [ns (tools/nodes converged)]
    (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip ns)))
    (is (= ["10.20.0.1" "10.20.0.2" "10.20.0.3"] (mapv :private-ip ns)))
    (is (= [1 2 3] (mapv :ordinal ns)))
    (is (= ["postgres-ha-fixture-1" "postgres-ha-fixture-2" "postgres-ha-fixture-3"]
           (mapv :name ns)))
    (testing "the network facts beside the nodes come from state too"
      (is (= "10.20.0.0/20" (:vpc-cidr (tools/data-fn converged)))))
    (testing "and reach the inventory, the DNS records and the acceptance aliases"
      (is (= "203.0.113.2"
             (get-in (json/parse-string (tools/inventory converged) true)
                     [:all :children :postgres :hosts :postgres-ha-fixture-2 :ansible_host])))
      (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"]
             (mapv :public-ip (:nodes (:data (first (tools/dns-specs converged)))))))
      (is (= ["postgres-ha-fixture-0" "postgres-ha-fixture-1" "postgres-ha-fixture-2"]
             (mapv :alias (:nodes (:data (first (tools/acceptance-specs converged))))))))))

(deftest the-legacy-state-is-translated-into-params
  (is (= "digitalocean" (:provider recorded)))
  (is (= [0 1 2] (mapv :index (:nodes recorded))))
  (is (every? nil? (map :role (:nodes recorded))))
  (is (= ["postgres-ha-fixture-1" "postgres-ha-fixture-2" "postgres-ha-fixture-3"]
         (mapv :name (:nodes recorded))))
  (is (= {:ip "203.0.113.2" :vpc_ip "10.20.0.2" :user "root" :sudoer "root"}
         (select-keys (second (:nodes recorded)) [:ip :vpc_ip :user :sudoer])))
  (is (= ["5a6b7c8d-0000-4000-8000-000000000001" "10.20.0.0/20"]
         (map recorded [:vpc_id :vpc_ip_range])))
  (is (empty? (cluster/node-errors validate/spec fixture recorded))
      "ONCE accepts the translation as a whole cluster")
  (is (= [] (tools/params-errors recorded))))

(deftest the-legacy-translation-refuses-to-guess
  (let [refusal (fn [outputs]
                  (try (tools/legacy-params fixture outputs "stage-dir") nil
                       (catch clojure.lang.ExceptionInfo e e)))]
    (testing "lists that disagree with each other"
      (let [e (refusal (assoc legacy-outputs :node_public_ips ["203.0.113.1" "203.0.113.2"]))]
        (is (= "legacy state lists 2 public addresses and 3 private addresses; refusing to guess the cluster"
               (ex-message e)))
        (is (= "stage-dir" (:dir (ex-data e))) "the SDK's step-error shape, so read-state reports it")))
    (testing "lists that disagree with cluster-nodes"
      (let [four (fn [v] (conj v (last v)))
            e (refusal (-> legacy-outputs
                           (update :node_public_ips four)
                           (update :node_private_ips four)))]
        (is (= "legacy state lists 4 public addresses and 4 private addresses; refusing to guess the cluster"
               (ex-message e)))))
    (testing "no network"
      (is (= "legacy state carries no vpc_id"
             (ex-message (refusal (dissoc legacy-outputs :vpc_id)))))
      (is (= "legacy state carries no vpc_id"
             (ex-message (refusal (assoc legacy-outputs :vpc_id " ")))))
      (is (= "legacy state carries no vpc_ip_range"
             (ex-message (refusal (dissoc legacy-outputs :vpc_ip_range))))))
    (testing "the range's form is params-errors' to refuse, the same as a recorded state"
      (is (= ["compute state vpc_ip_range \"10.20.0.1/20\" is not a canonical IPv4 network such as 10.40.0.0/24"]
             (tools/params-errors (tools/legacy-params fixture (assoc legacy-outputs :vpc_ip_range "10.20.0.1/20") "x")))))))

(deftest params-errors-hold-the-extension-keys
  (is (= [] (tools/params-errors recorded)))
  (is (= ["compute state carries no vpc_id"] (tools/params-errors (dissoc recorded :vpc_id))))
  (is (= ["compute state carries no vpc_id"] (tools/params-errors (assoc recorded :vpc_id " "))))
  (is (= ["compute state carries no vpc_ip_range"] (tools/params-errors (assoc recorded :vpc_ip_range nil))))
  (is (= ["compute state vpc_ip_range \"10.20.0.1/20\" is not a canonical IPv4 network such as 10.40.0.0/24"]
         (tools/params-errors (assoc recorded :vpc_ip_range "10.20.0.1/20"))))
  (is (= ["compute state carries no vpc_id" "compute state carries no vpc_ip_range"]
         (tools/params-errors {}))))

(deftest load-infrastructure-adopts-the-state-preflight-handed-on
  (let [load (fn [state]
               (tools/load-infrastructure-step
                (assoc fixture :green/event :delete :postgres-ha/state state)))]
    (testing "a recorded cluster"
      (let [r (load {:params recorded})]
        (is (= 0 (:green/exit r)))
        (is (= recorded (:once/cluster r)))
        (is (true? (:postgres-ha/infrastructure-present? r)))
        (is (not (contains? r :postgres-ha/state)))
        (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip (tools/nodes r))))))
    (testing "a readable state that records no cluster leaves nothing to clean up"
      (let [r (load {:params nil})]
        (is (= 0 (:green/exit r)))
        (is (false? (:postgres-ha/infrastructure-present? r)))
        (is (not (contains? r :once/cluster)))
        (is (= ["192.0.2.11" "192.0.2.12" "192.0.2.13"] (mapv :public-ip (tools/nodes r)))
            "the ssh-config withdrawal is keyed by alias, so the fallbacks are harmless here")))
    (testing "an unreadable backend fails closed"
      (let [r (load {:error "tofu output failed: no backend"})]
        (is (= 1 (:green/exit r)))
        (is (str/includes? (:green/err r) "could not read the infrastructure state for the delete cleanup"))
        (is (str/includes? (:green/err r) "no backend"))))
    (testing "a partial cluster is refused with ONCE's message"
      (let [r (load {:params (update recorded :nodes #(vec (take 2 %)))})]
        (is (= 1 (:green/exit r)))
        (is (= "the compute stage did not report nodes this package declares: 2" (:green/err r)))))
    (testing "an adopted cluster without its extension keys is refused"
      (let [r (load {:params (dissoc recorded :vpc_id)})]
        (is (= 1 (:green/exit r)))
        (is (= "compute state carries no vpc_id" (:green/err r)))))))

(deftest a-real-create-resolves-the-cluster-from-the-apply
  ;; The apply's `params` output, string-keyed as `tofu output -json` parses
  ;; it, is what every later stage reads; never the fallbacks.
  (let [opts (assoc fixture :green/event :create)
        apply (fn [params]
                (tools/resolve-infrastructure
                 opts (cond-> (assoc opts :green/exit 0)
                        params (assoc :postgres-ha/outputs {:params (walk/stringify-keys params)}))))]
    (let [r (apply recorded)]
      (is (= 0 (:green/exit r)))
      (is (= recorded (:once/cluster r)))
      (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip (tools/nodes r)))))
    (let [r (apply nil)]
      (is (= 1 (:green/exit r)))
      (is (= cluster/no-params-message (:green/err r))))
    (let [r (apply (update recorded :nodes #(vec (take 2 %))))]
      (is (= 1 (:green/exit r)))
      (is (= "the compute stage did not report nodes this package declares: 2" (:green/err r))))
    (let [r (apply (dissoc recorded :vpc_ip_range))]
      (is (= 1 (:green/exit r)))
      (is (= "compute state carries no vpc_ip_range" (:green/err r))))
    (testing "a failed apply, a delete and a build hand the result on untouched"
      (is (= 1 (:green/exit (tools/resolve-infrastructure opts (assoc opts :green/exit 1 :green/err "apply failed")))))
      (is (not (contains? (tools/resolve-infrastructure (assoc opts :green/event :build) (assoc opts :green/exit 0)) :once/cluster)))
      (is (= 0 (:green/exit (tools/resolve-infrastructure (assoc opts :green/event :delete) (assoc opts :green/exit 0))))))))

(deftest the-local-play-receives-one-block-of-aliases
  ;; ssh-config.md: the addresses and the aliases are extra-vars, never
  ;; rendered; the marker is the profile; the bare profile reaches node 0.
  (let [vars (tools/ansible-local-extra-vars (assoc converged :green/event :create))]
    (is (= "postgres-ha-fixture" (:host_alias vars)))
    (is (= [{:name "postgres-ha-fixture" :ip "203.0.113.1"}
            {:name "postgres-ha-fixture-0" :ip "203.0.113.1"}
            {:name "postgres-ha-fixture-1" :ip "203.0.113.2"}
            {:name "postgres-ha-fixture-2" :ip "203.0.113.3"}]
           (:ssh_hosts vars)))
    (is (= "present" (:block_state vars)))
    (is (= "~/.ssh/id_ed25519" (:ssh_private_key vars)))
    (testing "the pre-standard per-node blocks are named so the play can remove them"
      (is (= ["postgres-ha-fixture-1" "postgres-ha-fixture-2" "postgres-ha-fixture-3"]
             (:legacy_aliases vars)))))
  (is (= "absent" (:block_state (tools/ansible-local-extra-vars (assoc fixture :green/event :delete)))))
  (testing "a build renders the play without an address"
    (let [rendered (slurp (io/resource "io/github/getcolors/postgres-ha/tools/ansible-local/main.yml"))]
      (is (str/includes? rendered "marker: \"# {mark} {{ host_alias }} ANSIBLE MANAGED BLOCK\""))
      (is (str/includes? rendered "{% for host in ssh_hosts %}"))
      (is (str/includes? rendered "insertbefore: BOF"))
      (is (not (re-find #"192\.0\.2|203\.0\.113" rendered))))))

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
    (is (= "[\"12345678\"]" (:ssh-keys-hcl data)))
    (testing "an overlay string renders the same list"
      (is (= "[\"203.0.113.10/32\", \"198.51.100.0/24\"]"
             (:client-sources-hcl (tools/infrastructure-data
                                   (assoc fixture :digitalocean-client-sources
                                          "203.0.113.10/32, 198.51.100.0/24"))))))))

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
