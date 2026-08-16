(ns io.github.getcolors.postgres-ha.workflow-test
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-ha.tools :as tools]
            [io.github.getcolors.postgres-ha.workflow :as workflow]))

(def fixture
  (let [file (io/file "test/fixtures/colors.yml")]
    (green-cli/read-state file (slurp file))))

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
            addresses that may already be gone, so they are read from remote
            state before anything is destroyed"
    (is (= [:postgres-ha/start :postgres-ha/load-infrastructure
            :postgres-ha/cluster :postgres-ha/ansible-local :postgres-ha/dns
            :postgres-ha/infrastructure :postgres-ha/generated-cleanup]
           (walk :delete)))))

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

(deftest a-real-create-demands-every-credential
  (let [result (workflow/start-step (assoc fixture :green/event :create) {})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COLORS_PAR_POSTGRES_ADMIN_PASSWORD"))
    (is (str/includes? (:green/err result) "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY"))))

(deftest a-dry-run-create-demands-none
  (let [result (workflow/start-step
                (assoc fixture :green/event :create :green/dry-run true) {})]
    (is (= 0 (:green/exit result)))))

(deftest destruction-stays-guarded
  (let [credentials {"COLORS_PAR_DO_TOKEN" "t"
                     "COLORS_PAR_CLOUDFLARE_API_TOKEN" "t"
                     "COLORS_PAR_R2_ACCESS_KEY_ID" "t"
                     "COLORS_PAR_R2_SECRET_ACCESS_KEY" "t"
                     "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID" "t"
                     "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY" "t"
                     "COLORS_PAR_POSTGRES_ADMIN_PASSWORD" "t"
                     "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD" "t"}
        guarded (workflow/start-step (assoc fixture :green/event :delete) credentials)]
    (is (= 2 (:green/exit guarded)))
    (is (str/includes? (:green/err guarded) "compute destruction is protected"))
    (testing "and is lifted for exactly one run, from the environment, never by
              editing the committed flag"
      (let [lifted (workflow/start-step
                    (assoc fixture :green/event :delete)
                    (assoc credentials "COLORS_PAR_COMPUTE_PREVENT_DESTROY" "false"))]
        (is (= 0 (:green/exit lifted)))))))

(deftest the-profile-overlay-is-refused
  (let [result (workflow/start-step (assoc fixture :green/event :build)
                                    {(green-cli/par-name :profile) "elsewhere"})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "profile"))))

(deftest defaults-describe-a-working-cluster-on-their-own
  (testing "a deployment should only have to say what is specific to it"
    (is (true? (:compute-prevent-destroy workflow/defaults)))
    (is (= 3 (:cluster-nodes workflow/defaults)))
    (is (= 1 (:patroni-synchronous-node-count workflow/defaults)))
    (is (false? (:cloudflare-proxied workflow/defaults)))
    (is (= "default" (:digitalocean-vpc-mode workflow/defaults)))))
