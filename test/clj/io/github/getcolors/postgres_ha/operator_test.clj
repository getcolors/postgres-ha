(ns io.github.getcolors.postgres-ha.operator-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-ha.operator :as operator]))

(def state-file "test/fixtures/colors.yml")
(def opts (green-cli/read-state state-file (slurp state-file)))

(defn- capture []
  (let [seen (atom nil)]
    [seen (fn [argv] (reset! seen argv) {:exit 0})]))

(deftest node-selection-is-explicit-and-bounded
  (is (= {:ordinal 1 :extra []} (operator/parse-args [])))
  (is (= {:ordinal 2 :extra []} (operator/parse-args ["--node" "2"])))
  (is (= {:ordinal 3 :extra ["--candidate" "x"]}
         (operator/parse-args ["--node" "3" "--candidate" "x"])))
  (is (= {:ordinal 1 :extra ["--candidate" "x"]}
         (operator/parse-args ["--" "--candidate" "x"])))
  (is (:error (operator/parse-args ["--node" "second"]))))

(deftest out-of-range-nodes-are-refused-before-anything-is-dispatched
  (let [[seen runner] (capture)
        result (operator/run state-file :status ["--node" "9"] runner {})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "--node must be between 1 and 3"))
    (is (nil? @seen) "a refused invocation must not reach a host")))

(deftest operator-verbs-dispatch-through-the-managed-ssh-alias
  (testing "so the identity file and host-key policy are defined once, by the
            local stage, rather than copied into every verb"
    (let [argv (operator/command :status opts 2 [])]
      (is (= "ssh" (first argv)))
      (is (some #(str/ends-with? (str %) ".ssh/config") argv))
      (is (some #(= "postgres-ha-fixture-2" %) argv))
      (is (str/includes? (last argv) "patronictl")))))

(deftest the-verbs-are-the-tools-not-a-second-opinion-about-the-cluster
  (is (= ["patronictl" "-c" "/etc/patroni/patroni.yml" "list"]
         (operator/remote-command :status opts [])))
  (is (= ["patronictl" "-c" "/etc/patroni/patroni.yml" "failover" "--force"]
         (operator/remote-command :failover opts [])))
  (is (= ["patronictl" "-c" "/etc/patroni/patroni.yml" "switchover" "--force"
          "--candidate" "postgres-ha-fixture-3"]
         (operator/remote-command :switchover opts ["--candidate" "postgres-ha-fixture-3"])))
  (testing "backup and verify-restore run exactly what the timers run, so a
            manual run cannot pass while the scheduled one is broken"
    (is (= ["/usr/local/bin/postgres-ha-backup"] (operator/remote-command :backup opts [])))
    (is (= ["/usr/local/bin/postgres-ha-restore-check"]
           (operator/remote-command :verify-restore opts [])))))

(deftest psql-goes-through-haproxy-and-never-carries-the-password-in-argv
  (let [remote (operator/remote-command :psql opts [])
        argv (operator/command :psql opts 1 [])]
    (is (= ["psql" "-h" "127.0.0.1" "-p" "5432" "-U" "postgres" "-d" "appdb"] remote))
    (testing "loopback HAProxy, not the local PostgreSQL: the node the operator
              picked may be a standby, and a read-only session that looks like
              a primary session is the worst possible answer"
      (is (= "127.0.0.1" (nth remote 2))))
    (is (some #(= "-t" %) argv) "psql needs a terminal for its password prompt")
    (is (not (some #(str/includes? (str %) "PGPASSWORD") argv)))))

(deftest the-profile-overlay-is-refused-here-too
  (let [[seen runner] (capture)
        result (operator/run state-file :status []
                             runner {(green-cli/par-name :profile) "elsewhere"})]
    (is (= 2 (:green/exit result)))
    (is (nil? @seen))))

(deftest an-unknown-verb-prints-usage-rather-than-guessing
  (let [[seen runner] (capture)
        result (operator/run state-file :restart [] runner {})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "Usage:"))
    (is (nil? @seen))))

(deftest a-missing-desired-state-file-is-a-usage-error
  (is (= 2 (:green/exit (operator/run "test/fixtures/absent.yml" :status []
                                      (second (capture)) {})))))

(deftest a-failing-command-propagates-a-nonzero-exit
  (is (= 3 (:green/exit (operator/run state-file :status []
                                      (fn [_] {:exit 3 :err "boom"}) {})))))
