(ns io.github.getcolors.postgres-ha.ssh-test
  (:require [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-ha.ssh :as ssh]
            [io.github.getcolors.postgres-ha.validate :as validate]))

(def fixture
  (green-cli/read-state "colors.yml" (slurp "test/fixtures/colors.yml")))

(def optout
  (green-cli/read-state "optout.yml" (slurp "test/fixtures/optout.yml")))

(deftest keygen-mode-is-the-absence-of-a-supplied-key
  (is (validate/keygen? fixture))
  (is (not (validate/keygen? optout)))
  (is (not (validate/keygen? (assoc fixture :digitalocean-ssh-keys "12345678")))))

(deftest a-build-never-names-the-operators-home
  ;; Committed goldens must mean the same thing on every workstation, so a
  ;; build renders a fixed placeholder rather than reading ~/.ssh.
  (let [opts (ssh/with-machine-key (assoc fixture :green/event :build))]
    (is (= "/home/build-placeholder/.ssh/postgres-ha-fixture" (:ssh-private-key-path opts)))
    (is (= "/home/build-placeholder/.ssh/postgres-ha-fixture.pub" (:ssh-public-key-path opts)))
    (testing "the placeholder lands on the provider's own machine-key key"
      (is (= "/home/build-placeholder/.ssh/postgres-ha-fixture.pub" (:digitalocean-ssh-keys opts))))
    (is (not (re-find #"build-placeholder" (str (System/getenv "HOME")))))))

(deftest a-dry-run-is-held-to-the-same-rule-as-a-build
  ;; A dry-run is a create that touches nothing; testing the event alone would
  ;; let it reach the real key path.
  (is (ssh/rendered-only? {:green/event :build}))
  (is (ssh/rendered-only? {:green/event :create :green/dry-run true}))
  (is (not (ssh/rendered-only? {:green/event :create})))
  (is (= "/home/build-placeholder/.ssh/postgres-ha-fixture"
         (:ssh-private-key-path (ssh/with-machine-key (assoc fixture :green/event :create :green/dry-run true))))))

(deftest real-events-render-the-real-path
  (let [opts (ssh/with-machine-key (assoc fixture :green/event :health))]
    (is (not (re-find #"build-placeholder" (:ssh-private-key-path opts))))
    (is (.endsWith ^String (:ssh-private-key-path opts) "/.ssh/postgres-ha-fixture"))))

(deftest opt-out-opts-pass-through-untouched
  (let [opts (assoc optout :green/event :build)]
    (is (= opts (ssh/with-machine-key opts)))
    (testing "nothing about the operator's key material is invented"
      (is (nil? (:ssh-private-key-path (ssh/with-machine-key opts)))))))
