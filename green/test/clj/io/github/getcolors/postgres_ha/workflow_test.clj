(ns io.github.getcolors.postgres-ha.workflow-test
  (:require [babashka.fs :as fs]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-ha.ssh :as ssh]
            [io.github.getcolors.postgres-ha.tools :as tools]
            [io.github.getcolors.postgres-ha.workflow :as workflow]))

(def fixture
  (let [file (io/file "test/fixtures/colors.yml")]
    (green-cli/read-state file (slurp file))))

(def optout
  (let [file (io/file "test/fixtures/optout.yml")]
    (green-cli/read-state file (slurp file))))

(def credentials
  {"COLORS_PAR_DO_TOKEN" "t"
   "COLORS_PAR_CLOUDFLARE_API_TOKEN" "t"
   "COLORS_PAR_R2_ACCESS_KEY_ID" "t"
   "COLORS_PAR_R2_SECRET_ACCESS_KEY" "t"
   "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID" "t"
   "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY" "t"
   "COLORS_PAR_POSTGRES_ADMIN_PASSWORD" "t"
   "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD" "t"})

(def recorded
  "`params` as a converged deployment records it."
  {:provider "digitalocean"
   :vpc_id "5a6b7c8d-0000-4000-8000-000000000001"
   :vpc_ip_range "10.20.0.0/20"
   :nodes (mapv (fn [i] {:index i :role nil :name (str "postgres-ha-fixture-" (inc i))
                         :ip (str "203.0.113." (inc i)) :vpc_ip (str "10.20.0." (inc i))
                         :user "root" :sudoer "root"})
                (range 3))})

;; The compute state is read once per run, through the reader, on a real
;; create or delete. Every lifecycle test injects one: nil is a readable state
;; holding no compute, a map is a recorded `params`, and a throw is a backend
;; that cannot be read.
(defn- start
  ([opts state] (start opts {} state))
  ([opts env state] (workflow/start-step opts env (fn [_] state))))

(defn- start-unreadable
  ;; The shape `green.tofu/outputs` throws: an ex-info carrying `:dir`. Only
  ;; that is an unreadable backend; anything else propagates as a defect.
  ([opts] (start-unreadable opts {}))
  ([opts env]
   (workflow/start-step opts env (fn [_] (throw (ex-info "tofu output failed: no backend" {:dir "x"}))))))

(defn- never [_] (throw (Exception. "the reader must not run")))

(defn- walk
  "Follow the static graph from :postgres-ha/start for `event`."
  [event]
  (loop [step :postgres-ha/start seen [] guard 0]
    (let [[_ & nexts] (workflow/wire-fn step {:green/event event})]
      (cond
        (< 20 guard) (conj seen :loop)
        (empty? nexts) (conj seen step)
        :else (recur (first nexts) (conj seen step) (inc guard))))))

(deftest create-walks-compute-dns-local-cluster-acceptance
  (testing "strictly sequential: DNS needs the addresses compute produced, the
            cluster play needs the inventory those addresses build, and
            acceptance needs both a converged cluster and a resolvable name"
    (is (= [:postgres-ha/start :postgres-ha/infrastructure :postgres-ha/dns
            :postgres-ha/ansible-local :postgres-ha/cluster
            :postgres-ha/acceptance]
           (walk :create)))))

(deftest delete-runs-the-same-edges-backwards-after-loading-state
  (testing "the local SSH configuration delete has to withdraw is keyed by
            nodes that may already be gone, so the cluster is adopted out of
            remote state before anything is destroyed"
    (is (= [:postgres-ha/start :postgres-ha/load-infrastructure
            :postgres-ha/cluster :postgres-ha/ansible-local :postgres-ha/dns
            :postgres-ha/infrastructure :postgres-ha/ssh-cleanup :postgres-ha/generated-cleanup]
           (walk :delete))))
  (testing "the keypair goes after the compute destroy (ssh-keypair.md §3.3)"
    (is (= [ssh/cleanup-step :postgres-ha/generated-cleanup]
           (workflow/wire-fn :postgres-ha/ssh-cleanup {:green/event :delete})))))

(deftest a-build-fills-the-placeholder-key-paths
  ;; Every event fills the machine-key paths in preflight so the templates and
  ;; the inventory render the same whichever step scaffolds them; a build gets
  ;; the fixed placeholder, never the operator's home.
  (let [r (workflow/start-step (assoc fixture :green/event :build) {})]
    (is (= 0 (:green/exit r)))
    (is (= "/home/build-placeholder/.ssh/postgres-ha-fixture" (:ssh-private-key-path r)))
    (is (true? (:ssh-keygen r))))
  (testing "opt-out invents no key path"
    (let [r (workflow/start-step (assoc optout :green/event :build) {})]
      (is (= 0 (:green/exit r)))
      (is (nil? (:ssh-private-key-path r)))
      (is (nil? (:ssh-keygen r))))))

(deftest build-follows-the-create-graph
  (is (= (walk :create) (walk :build))))

(deftest every-side-effecting-step-is-skipped-by-dry-run
  (testing "a step that reaches a provider and is not in this list makes
            --dry-run a lie"
    (let [effecting (set workflow/side-effecting-steps)]
      (doseq [step (concat (walk :create) (walk :delete))
              :when (not= step :postgres-ha/start)]
        (is (contains? effecting step) (str step " is not advised for dry-run))"))))))

(deftest remote-state-keys-are-per-stage-and-profile-scoped
  (let [advice (workflow/backend-advice tools/infrastructure-tool)
        dir (str (io/file (System/getProperty "java.io.tmpdir")
                          (str "postgres-ha-backend-" (System/currentTimeMillis))))
        opts (assoc fixture :workdir dir)]
    (advice opts)
    (let [written (slurp (io/file (tools/tool-dir opts tools/infrastructure-tool)
                                  "backend.tf.json"))]
      (is (str/includes? written "postgres-ha-fixture/postgres-ha-infrastructure.tfstate"))
      (is (str/includes? written "fixture-state"))
      (testing "R2 authenticates through the AWS environment chain; naming the
                keys in the backend document would write them to disk"
        (is (not (str/includes? written "access_key")))
        (is (not (str/includes? written "secret_key")))))))

(deftest a-build-needs-no-credential
  (testing "which is what makes build and --dry-run the safe way to review a
            colors.yml edit on a fresh checkout"
    (let [result (workflow/start-step (assoc fixture :green/event :build) {})]
      (is (= 0 (:green/exit result))))))

(deftest build-and-dry-run-never-read-the-state
  ;; A throwing reader proves nothing on these paths reaches the backend.
  (doseq [opts [(assoc fixture :green/event :build)
                (assoc fixture :green/event :create :green/dry-run true)
                (assoc fixture :green/event :delete :green/dry-run true)]]
    (let [r (workflow/start-step opts {} never)]
      (is (= 0 (:green/exit r)))
      (is (not (contains? r :postgres-ha/state))))))

(deftest a-real-create-demands-every-credential
  (let [result (start (assoc fixture :green/event :create) nil)]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COLORS_PAR_POSTGRES_ADMIN_PASSWORD"))
    (is (str/includes? (:green/err result) "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY"))))

(deftest a-dry-run-create-demands-none
  (let [result (workflow/start-step
                (assoc fixture :green/event :create :green/dry-run true) {})]
    (is (= 0 (:green/exit result)))))

(deftest destruction-stays-guarded
  (let [guarded (start (assoc fixture :green/event :delete) credentials nil)]
    (is (= 2 (:green/exit guarded)))
    (is (str/includes? (:green/err guarded) "compute destruction is protected"))
    (testing "and is lifted for exactly one run, from the environment, never by
              editing the committed flag"
      (let [lifted (start (assoc fixture :green/event :delete)
                          (assoc credentials "COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false")
                          nil)]
        (is (= 0 (:green/exit lifted)))))))

(deftest the-profile-overlay-is-refused
  (let [result (workflow/start-step (assoc fixture :green/event :build)
                                    {(green-cli/par-name :profile) "elsewhere"})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "profile")))
  (testing "and the state is not read for a refused profile, nor for invalid desired state"
    (let [env (assoc credentials "COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false")]
      (is (= 2 (:green/exit (workflow/start-step (assoc fixture :green/event :delete)
                                                 (assoc env (green-cli/par-name :profile) "elsewhere")
                                                 never))))
      (is (= 2 (:green/exit (workflow/start-step (assoc fixture :green/event :delete :cluster-nodes 2)
                                                 env never)))))))

(deftest defaults-describe-a-working-cluster-on-their-own
  (testing "a deployment should only have to say what is specific to it"
    (is (true? (:compute-prevent-destroy workflow/defaults)))
    (is (= 3 (:cluster-nodes workflow/defaults)))
    (is (= 1 (:patroni-synchronous-node-count workflow/defaults)))
    (is (false? (:cloudflare-proxied workflow/defaults)))
    (is (= "default" (:digitalocean-vpc-mode workflow/defaults)))
    (is (= "digitalocean" (:provider-compute workflow/defaults)))))

;; --- the Compute Cluster Standard's safety boundaries ------------------------

(deftest a-provider-switch-is-refused-before-the-credentials
  (doseq [event [:create :delete]]
    (testing (str "digitalocean selected, vultr recorded, on " (name event))
      (let [r (start (assoc fixture :green/event event)
                     {"COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false"}
                     (assoc recorded :provider "vultr"))]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (:green/err r)
                           "state holds a vultr machine; set provider-compute back to vultr and delete first"))
        ;; The validator order is the thing under test: the actionable error,
        ;; not a missing token for the provider that was just selected.
        (is (not (str/includes? (:green/err r) "required credential is not set")))))))

(deftest legacy-state-accepts-only-the-default-provider
  ;; A recorded provider is absent from every pre-adoption state; on the one
  ;; provider this package offers that is the default, and the run proceeds
  ;; to its credentials. A second provider would be refused by selection
  ;; before the state is read, so the other branch of the rule has no
  ;; reachable input here.
  (doseq [event [:create :delete]]
    (let [r (start (assoc fixture :green/event event)
                   {"COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false"}
                   (dissoc recorded :provider))]
      (is (= 2 (:green/exit r)) (name event))
      (is (not (str/includes? (:green/err r) "state holds")) (name event))
      (is (str/includes? (:green/err r) "required credential is not set") (name event)))))

(deftest a-matching-provider-passes-to-the-credentials
  (let [r (start (assoc fixture :green/event :create) recorded)]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest an-unreadable-backend-counts-as-no-state-on-create
  ;; A fresh clone has no readable state and must still be able to create.
  (let [r (start-unreadable (assoc fixture :green/event :create))]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "could not read")))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest a-real-create-on-a-fresh-work-directory-reports-the-credentials-not-a-crash
  ;; No reader stub: the real `state-output` runs against a work directory
  ;; that holds no stage yet, as a fresh clone's does. It renders the stage,
  ;; writes its backend and initializes it, and finds no state — or fails to
  ;; launch or initialize tofu, which green 3f33f5d reports as its own step
  ;; error carrying :dir. Either way ONCE's `read-state` counts it as no
  ;; usable state, so the create reports its credentials instead of crashing.
  (let [work (str (fs/create-temp-dir {:prefix "postgres-ha-fresh"}))]
    (try
      (let [r (workflow/start-step (assoc fixture :workdir work :green/event :create) {})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (str (:green/err r)) "COLORS_PAR_DO_TOKEN"))
        (is (not (str/includes? (str (:green/err r)) "could not read"))))
      (finally (fs/delete-tree work)))))

(deftest an-unreadable-backend-fails-a-real-delete-closed
  ;; Swallowing it is how a teardown ends up converging against 192.0.2.11.
  ;; Preflight hands the read on; `load-infrastructure`, the first step after
  ;; it and before any side effect, is where the delete stops.
  (let [r (start-unreadable (assoc fixture :green/event :delete)
                            (assoc credentials "COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false"))]
    (is (= 0 (:green/exit r)))
    (is (= {:error "tofu output failed: no backend"} (:postgres-ha/state r)))
    (let [l (tools/load-infrastructure-step r)]
      (is (= 1 (:green/exit l)))
      (is (str/includes? (:green/err l) "could not read the infrastructure state for the delete cleanup"))
      (is (str/includes? (:green/err l) "no backend")))))

(deftest a-real-delete-adopts-the-recorded-cluster
  (let [env (assoc credentials "COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false")
        r (start (assoc fixture :green/event :delete) env recorded)
        l (tools/load-infrastructure-step r)]
    (is (= 0 (:green/exit r)))
    (is (= {:params recorded} (:postgres-ha/state r)))
    (is (= 0 (:green/exit l)))
    (is (= recorded (:once/cluster l)))
    (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3"] (mapv :public-ip (tools/nodes l))))
    (testing "and withdraws every alias of the block it wrote"
      (is (= ["postgres-ha-fixture" "postgres-ha-fixture-0" "postgres-ha-fixture-1" "postgres-ha-fixture-2"]
             (mapv :name (:ssh_hosts (tools/ansible-local-extra-vars l)))))
      (is (= "absent" (:block_state (tools/ansible-local-extra-vars l)))))
    (testing "a readable state without a cluster leaves nothing to clean up"
      (let [l (tools/load-infrastructure-step (start (assoc fixture :green/event :delete) env nil))]
        (is (= 0 (:green/exit l)))
        (is (false? (:postgres-ha/infrastructure-present? l)))))))

(deftest a-partial-cluster-is-refused-on-a-real-run
  (let [partial (update recorded :nodes #(vec (take 2 %)))
        r (start (assoc fixture :green/event :delete)
                 (assoc credentials "COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false")
                 partial)]
    (is (= 0 (:green/exit r)) "the switch guard reads only the provider")
    (let [l (tools/load-infrastructure-step r)]
      (is (= 1 (:green/exit l)))
      (is (= "the compute stage did not report nodes this package declares: 2" (:green/err l))))))
