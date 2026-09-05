(ns io.github.getcolors.postgres-ha.validate-test
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.postgres-ha.validate :as validate]))

(def fixture
  (let [file (io/file "test/fixtures/colors.yml")]
    (green-cli/read-state file (slurp file))))

(defn- errors [overrides]
  (validate/state-errors (merge fixture overrides)))

(defn- has? [messages re]
  (boolean (some #(re-find re %) messages)))

(deftest the-fixture-is-renderable
  (is (= [] (validate/state-errors fixture))
      "the golden fixture must stay valid, or the golden proves nothing"))

(def optout
  (let [file (io/file "test/fixtures/optout.yml")]
    (green-cli/read-state file (slurp file))))

(deftest both-keypair-modes-are-renderable
  ;; The SSH Keypair Standard has two modes and conformance means both hold.
  (is (= [] (validate/state-errors optout)))
  (is (validate/keygen? fixture))
  (is (not (validate/keygen? optout)))
  (testing "the machine key is never required: its absence is keygen mode"
    (is (not (has? (validate/state-errors fixture) #"digitalocean-ssh-keys")))))

(deftest the-private-key-path-is-desired-state-in-opt-out-mode-only
  (is (has? (validate/state-errors (dissoc optout :digitalocean-ssh-private-key))
            #"digitalocean-ssh-private-key is required when digitalocean-ssh-keys is supplied"))
  (testing "keygen mode names the generated key itself and asks for no path"
    (is (= [] (validate/state-errors (dissoc fixture :digitalocean-ssh-private-key))))))

(deftest every-problem-is-reported-at-once
  (testing "a person fixing desired state one error per run gives up on it"
    (let [messages (errors {:cluster-host nil :postgres-database "Not An Ident"
                            :backup-retention-full 0 :etcd-sha256 "nope"})]
      (is (<= 4 (count messages)))
      (is (has? messages #":cluster-host is required"))
      (is (has? messages #"postgres-database must be an unquoted lowercase SQL identifier"))
      (is (has? messages #"backup-retention-full must be a positive integer"))
      (is (has? messages #"etcd-sha256 must be the lowercase hex SHA-256")))))

(deftest the-profile-overlay-is-refused
  (let [par (green-cli/par-name :profile)]
    (is (nil? (validate/env-errors {})))
    (is (nil? (validate/env-errors {par ""})))
    (is (has? (validate/env-errors {par "somebody-elses-deployment"})
              #"takes profile from colors.yml only"))))

(deftest the-spec-describes-one-homogeneous-role-on-a-discovered-network
  ;; The Compute Cluster Standard's spec is data ONCE reads; this is the one
  ;; place its content is asserted, so a drift in any colour is a test
  ;; failure and not a rendered surprise.
  (is (= [] (cluster/spec-errors validate/spec)))
  (is (= ["digitalocean"] (keys (:registry validate/spec))))
  (is (= "digitalocean" (:default validate/spec)))
  (is (= {:mode :discovered} (get-in validate/spec [:registry "digitalocean" :network])))
  (is (= {:non-empty ["ssh-sources" "client-sources"] :may-be-empty []} (:sources validate/spec)))
  (is (= [{:role nil :count-key :cluster-nodes :count 3 :fallback-offset 11}]
         (:roles validate/spec)))
  (is (nil? (:entry validate/spec)) "the bare profile alias reaches node 0")
  (is (= "10.114.0.0/20" (:fallback-subnet validate/spec)))
  (is (= [] (cluster/topology-errors validate/spec fixture)))
  (testing "the registry's required keys are demanded through ONCE"
    (doseq [k (get-in validate/compute-providers ["digitalocean" :required])]
      (is (has? (errors {k nil}) (re-pattern (str k " is required"))) (str k)))))

(deftest the-vpc-is-discovered-and-cannot-be-described
  (testing "accepting a VPC identifier would let one deployment be edited onto
            another's private network while passing every other check"
    (doseq [k validate/forbidden-vpc-keys]
      (is (has? (errors {k "10.0.0.0/16"})
                #"must not be configured; the regional default VPC is discovered")
          (str k " must be refused"))))
  (testing "the two spellings ONCE knows are refused by its discovered-network
            rule, once, with its message"
    (is (= [":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"]
           (errors {:digitalocean-vpc-uuid "00000000-0000-0000-0000-000000000000"})))
    (is (= [":digitalocean-vpc-cidr must be absent; this package must not create a VPC"]
           (errors {:digitalocean-vpc-cidr "10.114.0.0/20"}))))
  (is (has? (errors {:digitalocean-vpc-mode "explicit"})
            #":digitalocean-vpc-mode must be default")))

(deftest the-node-budget-is-fixed
  (is (has? (errors {:cluster-nodes 2}) #":cluster-nodes must be 3"))
  (is (has? (errors {:cluster-nodes 5}) #":cluster-nodes must be 3"))
  (testing "a count that is not a positive integer is ONCE's to refuse too"
    (is (has? (errors {:cluster-nodes "3"}) #":cluster-nodes must be a positive integer"))))

(deftest only-the-providers-this-package-implements-are-accepted
  (is (has? (errors {:provider-compute "hcloud"}) #":provider-compute must be one of digitalocean"))
  (is (has? (errors {:provider-dns "yandex"}) #"unsupported :provider-dns"))
  (is (has? (errors {:provider-backend "gcs"}) #"unsupported :provider-backend")))

(deftest ports-that-share-an-address-must-differ
  (testing "the primary listener deliberately reuses the PostgreSQL port,
            because HAProxy binds the public address and PostgreSQL the private one"
    (is (= [] (errors {:haproxy-primary-port 5432 :postgres-port 5432}))))
  (is (has? (errors {:haproxy-replica-port 5432})
            #":haproxy-replica-port must differ from :postgres-port"))
  (is (has? (errors {:etcd-client-port 8008})
            #"port 8008 is claimed by"))
  (is (has? (errors {:restore-check-port 7000})
            #"port 7000 is claimed by")))

(deftest quorum-settings-cannot-describe-a-cluster-that-stalls
  (testing "requiring every standby to acknowledge leaves a three-node cluster
            that cannot tolerate losing one, which is the whole point of it"
    (is (has? (errors {:patroni-synchronous-node-count 3})
              #":patroni-synchronous-node-count must be between 1 and 2")))
  (is (has? (errors {:patroni-synchronous-node-count 0})
            #":patroni-synchronous-node-count"))
  (testing "two is defensible — a stricter durability bar the cluster can still
            degrade from — so it is allowed rather than legislated against"
    (is (= [] (errors {:patroni-synchronous-node-count 2}))))
  (testing "a TTL that can expire between two health checks is a cluster that
            fails over because nothing went wrong"
    (is (has? (errors {:patroni-ttl 15 :patroni-loop-wait 10})
              #":patroni-ttl must exceed twice :patroni-loop-wait"))))

(deftest the-endpoint-must-be-reachable-as-postgresql
  (is (has? (errors {:cloudflare-proxied true})
            #"Cloudflare's proxy does not carry the PostgreSQL wire protocol"))
  (is (has? (errors {:cluster-host "pg-ha.somewhere.else"})
            #":cluster-host must be inside :cloudflare-zone"))
  (is (has? (errors {:cloudflare-record-ttl 30})
            #":cloudflare-record-ttl must be 1 \(automatic\) or between 60 and 86400")))

(deftest the-client-connect-timeout-is-desired-state-not-folklore
  (testing "the endpoint resolves to every node, so a client can try an address
            whose machine is powered off — which black-holes rather than
            refuses, and without a bound libpq waits out the OS TCP retry.
            Measured on a real failover: one probe in three pays it."
    (is (has? (errors {:client-connect-timeout-seconds 0})
              #":client-connect-timeout-seconds must be between 1 and 30"))
    (is (has? (errors {:client-connect-timeout-seconds 120})
              #":client-connect-timeout-seconds must be between 1 and 30"))
    (is (has? (errors {:client-connect-timeout-seconds nil})
              #":client-connect-timeout-seconds"))
    (is (= [] (errors {:client-connect-timeout-seconds 5})))))

(deftest ingress-stays-scoped
  ;; The list and CIDR checks are ONCE's, with its messages; the refusal of the
  ;; world is this package's own and holds however the list is spelled.
  (doseq [k [:digitalocean-ssh-sources :digitalocean-client-sources]]
    (is (= [(str k " must not contain 0.0.0.0/0; administrative and database ingress stay scoped")]
           (errors {k ["0.0.0.0/0"]})))
    (is (has? (errors {k "203.0.113.10/32, 0.0.0.0/0"}) #"must not contain 0.0.0.0/0"))
    (is (= [(str k " must list at least one CIDR")] (errors {k []})))
    (is (= [(str k " entry \"203.0.113.10\" is not an IPv4 or IPv6 CIDR")]
           (errors {k ["203.0.113.10"]}))))
  (testing "a string is a list, the way an overlay carries one"
    (is (= [] (errors {:digitalocean-ssh-sources "203.0.113.10/32, 198.51.100.0/24"})))))

(deftest blast-radius-is-separated
  (is (has? (errors {:backup-r2-bucket (:r2-bucket fixture)})
            #"must not be the OpenTofu state bucket")))

(deftest versions-are-pinned-precisely-enough-to-reproduce
  (is (has? (errors {:patroni-package-version "4.1.5"})
            #"must be a full Debian package version"))
  (is (has? (errors {:pgbackrest-package-version "latest"})
            #"must be a full Debian package version"))
  (is (has? (errors {:etcd-version "3.5.33"}) #":etcd-version must be an exact vX.Y.Z"))
  (is (has? (errors {:haproxy-version "2.8.5"}) #":haproxy-version must be a distribution major.minor")))

(deftest the-restore-check-tolerance-cannot-be-set-below-what-archiving-allows
  (is (has? (errors {:restore-check-max-lag-seconds 30})
            #":restore-check-max-lag-seconds must exceed 120")))

(deftest credentials-are-demanded-by-name
  (testing "with none set, every one is named once"
    (let [messages (vec (validate/secret-errors fixture))]
      (is (= (count messages) (count (distinct messages))))
      (doseq [par ["COLORS_PAR_DO_TOKEN" "COLORS_PAR_CLOUDFLARE_API_TOKEN"
                   "COLORS_PAR_R2_ACCESS_KEY_ID" "COLORS_PAR_R2_SECRET_ACCESS_KEY"
                   "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID"
                   "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY"
                   "COLORS_PAR_POSTGRES_ADMIN_PASSWORD"
                   "COLORS_PAR_POSTGRES_REPLICATION_PASSWORD"]]
        (is (has? messages (re-pattern par)) (str par " must be demanded")))))
  (testing "and a supplied one stops being demanded"
    (is (not (has? (validate/secret-errors (assoc fixture :do-token "t"))
                   #"COLORS_PAR_DO_TOKEN\b")))))

(deftest no-message-can-contain-a-credential
  (let [loaded (merge fixture {:do-token "tok-do" :cloudflare-api-token "tok-cf"
                               :postgres-admin-password "hunter2"
                               :backup-r2-secret-access-key "sekrit"})
        messages (concat (validate/state-errors loaded)
                         (validate/secret-errors loaded))]
    (doseq [secret ["tok-do" "tok-cf" "hunter2" "sekrit"]]
      (is (not (some #(str/includes? % secret) messages))
          (str "a validation message rendered " secret)))))
