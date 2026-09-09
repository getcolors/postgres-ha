(ns io.github.getcolors.postgres-ha.workflow-test
  (:require [clojure.test :refer [deftest is]]
            [clojure.java.io :as io]
            [green.workflow :as wf]
            [io.github.getcolors.compute-orchestration :as compute]
            [io.github.getcolors.compute-inspection :as inspection]
            [io.github.getcolors.postgres-ha.workflow :as workflow]
            [io.github.getcolors.postgres-ha.tools :as tools]
            [io.github.getcolors.postgres-ha.compute :as cluster]
            [io.github.getcolors.postgres-ha.ssh-config :as config]
            [io.github.getcolors.postgres-ha.validate :as validate]
            [io.github.getcolors.postgres-ha.validate-test :refer [base]]
            [io.github.getcolors.postgres-ha.tools-test :refer [recorded]]))
(def params recorded)
(deftest adapter-delegates-compute-and-retains-shared-network
  (with-redefs [compute/orchestrate (fn [& _] {:status "ready" :cluster params :shared {:params {:network_cidr "10.20.0.0/20"}} :key {:private_key_path "/tmp/owned"}})]
    (let [result (tools/infrastructure-step (assoc base :green/event :create))]
      (is (= params (:colors-compute/cluster result)))
      (is (= "10.20.0.0/20" (get-in result [:colors-compute/shared :params :network_cidr])))
      (is (= "/tmp/owned" (:ssh-private-key-path result))))))
(deftest deletion-loads-only-owned-inventory-and-protection-precedes-inspection
  (with-redefs [inspection/read-deployment (fn [& _] {:status "present" :cluster params :shared {:params {:network_cidr "10.20.0.0/20"}}})]
    (is (= params (:colors-compute/cluster (tools/load-infrastructure-step (assoc base :green/event :delete))))))
  (with-redefs [inspection/read-deployment (fn [& _] {:status "error"})]
    (is (= 1 (:green/exit (tools/load-infrastructure-step (assoc base :green/event :delete)))))))
(deftest full-native-build-is-credential-free
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory "pg-green-build-" (make-array java.nio.file.attribute.FileAttribute 0)))]
    (try
      (with-redefs [compute/orchestrate (fn [& _] (throw (AssertionError. "build must not compute")))
                    inspection/read-deployment (fn [& _] (throw (AssertionError. "build must not inspect")))]
        (let [result (wf/run workflow/workflow (assoc base :green/event :build :workdir (.getPath directory)))
              names (set (map #(.getName %) (file-seq directory)))]
          (is (= 0 (:green/exit result)) (:green/err result))
          (is (contains? names "node.tf.json"))
          (is (contains? names "shared.tf.json"))
          (is (contains? names "inventory.json"))))
      (finally (doseq [file (reverse (file-seq directory))] (io/delete-file file))))))

(deftest retired-resumes-only-idempotent-local-cleanup
  (let [dir (.toFile (java.nio.file.Files/createTempDirectory "postgres-ha-retired-" (make-array java.nio.file.attribute.FileAttribute 0)))
        opts {:profile "retired" :workdir (str dir) :green/event :delete}
        paths [(io/file (tools/tool-dir opts tools/acceptance-tool) "acceptance.sh")]
        keep (io/file dir "keep") seen (atom []) inspection-exit (atom 0)
        native (wf/workflow {:start :postgres-ha/start :next-fn workflow/next-steps
          :wire-fn (fn [step current]
            (case step
              :postgres-ha/start [(fn [o] (swap! seen conj step) (assoc o :green/exit 0)) :postgres-ha/load-infrastructure]
              :postgres-ha/load-infrastructure [(fn [o] (swap! seen conj step) (assoc o :green/exit @inspection-exit :postgres-ha/already-destroyed true)) :forbidden/remote]
              :postgres-ha/generated-cleanup [(fn [o] (swap! seen conj step) ((first (workflow/wire-fn step o)) o))]
              [(fn [_] (throw (ex-info "unexpected remote stage" {:step step})))]))})]
    (try
      (doseq [path paths] (io/make-parents path) (spit path "synthetic leftover"))
      (spit keep "unrelated")
      (dotimes [_ 2]
        (reset! seen [])
        (is (zero? (:green/exit (wf/run native opts))))
        (is (= [:postgres-ha/start :postgres-ha/load-infrastructure :postgres-ha/generated-cleanup] @seen))
        (is (every? #(not (.exists %)) paths))
        (is (= "unrelated" (slurp keep))))
      (reset! inspection-exit 1) (reset! seen [])
      (is (= 1 (:green/exit (wf/run native opts))))
      (is (= [:postgres-ha/start :postgres-ha/load-infrastructure] @seen))
      (is (= [] (workflow/next-steps :postgres-ha/load-infrastructure [:forbidden/remote] (assoc opts :green/exit 1 :postgres-ha/already-destroyed true))))
      (is (not (.exists (io/file dir ".ssh"))))
      (finally (doseq [f (reverse (file-seq dir))] (io/delete-file f true))))))
