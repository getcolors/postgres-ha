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
