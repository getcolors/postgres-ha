(ns io.github.getcolors.postgres-ha.validate
  "Credential-free desired-state validation, and the provider registry it uses.

  The registry is package-owned rather than inherited from ONCE: this package
  provisions three droplets, its own firewall and its own DNS record set, so
  the keys a stage interpolates are not ONCE's single-server keys. Keeping the
  table here means one place describes what a provider choice requires, what it
  needs as a credential, and which of those credentials OpenTofu reads natively
  from the environment.

  Every check accumulates. A run reports all of a file's problems at once with
  exit 2, because fixing desired state one error per invocation is how a person
  gives up on a config file."
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.postgres-ha.utils :as utils]))

(def providers
  {:provider-compute
   {"digitalocean"
    {:required [:digitalocean-name :digitalocean-region :digitalocean-size
                :digitalocean-image :digitalocean-ssh-keys
                :digitalocean-ssh-private-key :digitalocean-ssh-sources
                :digitalocean-client-sources :digitalocean-vpc-mode]
     :secrets [:do-token]
     :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}}

   :provider-dns
   {"cloudflare"
    {:required [:cloudflare-zone :cloudflare-proxied :cloudflare-record-ttl
                :cluster-host]
     :secrets [:cloudflare-api-token]
     :tofu-env {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}}}

   :provider-backend
   {"local" {:required [] :secrets [] :tofu-env {}}
    "s3" {:required [:s3-bucket :s3-region]
          :secrets [:s3-access-key-id :s3-secret-access-key]
          :tofu-env {:s3-access-key-id "AWS_ACCESS_KEY_ID"
                     :s3-secret-access-key "AWS_SECRET_ACCESS_KEY"}}
    ;; R2 is S3-compatible and therefore authenticates through the AWS chain.
    ;; These are the *state* credentials; the backup repository has its own
    ;; pair so a leaked backup key cannot rewrite infrastructure state.
    "r2" {:required [:r2-bucket :r2-endpoint]
          :secrets [:r2-access-key-id :r2-secret-access-key]
          :tofu-env {:r2-access-key-id "AWS_ACCESS_KEY_ID"
                     :r2-secret-access-key "AWS_SECRET_ACCESS_KEY"}}}})

(def slots [:provider-compute :provider-dns :provider-backend])
(def profile-par (green-cli/par-name :profile))

(def own-required
  [:profile :workdir :cluster-name :cluster-host :cluster-nodes
   :postgres-version :postgres-port :postgres-database
   :postgres-admin-user :postgres-replication-user
   :patroni-package-version :patroni-rest-port :patroni-ttl :patroni-loop-wait
   :patroni-retry-timeout :patroni-synchronous-node-count
   :etcd-version :etcd-sha256 :etcd-client-port :etcd-peer-port
   :haproxy-version :haproxy-primary-port :haproxy-replica-port
   :haproxy-stats-port :client-connect-timeout-seconds
   :pgbackrest-package-version :backup-stanza :backup-oncalendar
   :backup-retention-full :restore-check-oncalendar :restore-check-port
   :restore-check-max-age-hours :restore-check-max-lag-seconds
   :heartbeat-oncalendar :heartbeat-retention-days
   :backup-r2-bucket :backup-r2-endpoint :backup-r2-region :backup-r2-prefix])

(def own-secrets
  [:postgres-admin-password :postgres-replication-password
   :backup-r2-access-key-id :backup-r2-secret-access-key])

;; A VPC is discovered, never described. Accepting any of these would let one
;; deployment place its nodes on another's network while still passing every
;; other check, so their mere presence is an error rather than a warning.
(def forbidden-vpc-keys
  [:digitalocean-vpc-id :digitalocean-vpc-uuid :digitalocean-vpc-cidr
   :digitalocean-vpc-name :digitalocean-vpc])

(defn placeholder?
  [x]
  (or (nil? x)
      (and (string? x)
           (or (str/blank? x) (= "REPLACE_ME" (str/upper-case x))))))

(defn entry [opts slot] (get-in providers [slot (get opts slot)]))
(defn tofu-env [opts slot] (:tofu-env (entry opts slot) {}))
(defn- slot-keys [opts field] (mapcat #(get (entry opts %) field []) slots))
(defn- missing [opts ks] (keep #(when (placeholder? (get opts %)) %) ks))

(defn env-errors
  [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set. postgres-ha takes profile from colors.yml only; "
          "an environment overlay could point this deployment at another's "
          "remote state and backup repository.")]))

(def ^:private dns-re
  #"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
(def ^:private cidr-re #"^(?:[0-9]{1,3}\.){3}[0-9]{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$")
(def ^:private profile-re #"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
(def ^:private identifier-re #"^[a-z_][a-z0-9_]{0,62}$")
(def ^:private stanza-re #"^[a-z][a-z0-9-]{0,31}$")
(def ^:private etcd-version-re #"^v[0-9]+\.[0-9]+\.[0-9]+$")
;; A Debian version, not a release version: PGDG revisions its own packaging
;; (`4.1.5-1.pgdg24.04+1`), and a pin that named only the upstream release
;; would still let two converges install different bytes.
(def ^:private deb-version-re #"^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.+~:-]+$")
(def ^:private sha256-re #"^[0-9a-f]{64}$")
(def ^:private oncalendar-re #"^[A-Za-z0-9 *,./:-]+$")
(def ^:private https-re #"^https://[A-Za-z0-9.-]+(?::[0-9]+)?/?$")
(def ^:private prefix-re #"^[A-Za-z0-9][A-Za-z0-9._/-]*$")

(defn valid-cidr?
  [value]
  (and (re-matches cidr-re (str value))
       (every? #(<= 0 % 255)
               (map parse-long
                    (str/split (first (str/split (str value) #"/")) #"\.")))))

(defn- positive-int? [x] (and (integer? x) (pos? x)))

(def ^:private exclusive-port-keys
  "Listeners that must each own a distinct port on every node.

  `:postgres-port` is deliberately absent. PostgreSQL binds only the node's
  private VPC address, while HAProxy binds only the public address and
  loopback, so the primary listener is expected to reuse 5432 — a client
  reaching `<cluster-host>:5432` and a replica streaming from
  `<private-ip>:5432` never contend. Every other listener here shares an
  address with at least one of the others, so a repeated number is a node that
  half-starts."
  [:patroni-rest-port :etcd-client-port :etcd-peer-port
   :haproxy-primary-port :haproxy-replica-port :haproxy-stats-port
   :restore-check-port])

(defn- distinct-port-errors
  [opts]
  (let [ports (keep #(let [v (get opts %)] (when (integer? v) [% v]))
                    exclusive-port-keys)
        dupes (->> ports
                   (group-by second)
                   (filter (fn [[_ v]] (< 1 (count v))))
                   (sort-by first))
        pg (:postgres-port opts)
        shadowed (when (integer? pg)
                   (keep (fn [[k v]]
                           (when (and (= v pg) (not= k :haproxy-primary-port)) k))
                         ports))]
    (concat
     (for [[port entries] dupes]
       (str "port " port " is claimed by "
            (str/join " and " (map (comp name first) entries))
            "; every listener on a node needs its own port"))
     (for [k (sort shadowed)]
       (str k " must differ from :postgres-port")))))

(defn state-errors
  [opts]
  (vec
   (concat
    (map #(str % " is required")
         (missing opts (concat own-required (slot-keys opts :required))))

    (for [slot slots
          :let [provider (get opts slot)]
          :when (not (contains? (get providers slot) provider))]
      (str "unsupported " slot " " (pr-str provider)))

    (when-not (= "digitalocean" (:provider-compute opts))
      [":provider-compute must be digitalocean"])
    (when-not (= "cloudflare" (:provider-dns opts))
      [":provider-dns must be cloudflare"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (when-not (boolean? (:cloudflare-proxied opts))
      [":cloudflare-proxied must be true or false"])
    (when (true? (:cloudflare-proxied opts))
      [":cloudflare-proxied must be false; Cloudflare's proxy does not carry the PostgreSQL wire protocol"])

    (when-not (or (placeholder? (:profile opts))
                  (re-matches profile-re (str (:profile opts))))
      [":profile must be a safe 1-63 character name"])

    (when-not (= utils/node-count (:cluster-nodes opts))
      [(str ":cluster-nodes must be " utils/node-count
            "; the topology colocates a quorum store on the database nodes and "
            "cannot elect with fewer")])

    (when-not (= "default" (str (:digitalocean-vpc-mode opts)))
      [":digitalocean-vpc-mode must be default; the regional default VPC is discovered at runtime"])
    (for [k forbidden-vpc-keys :when (contains? opts k)]
      (str k " must not be configured; the regional default VPC is discovered at runtime"))

    (for [k [:cluster-host :cloudflare-zone]
          :let [v (get opts k)]
          :when (and (not (placeholder? v)) (not (re-matches dns-re (str v))))]
      (str k " must be a DNS name"))
    (when (and (not (placeholder? (:cluster-host opts)))
               (not (placeholder? (:cloudflare-zone opts)))
               (not (or (= (str (:cluster-host opts)) (str (:cloudflare-zone opts)))
                        (str/ends-with? (str (:cluster-host opts))
                                        (str "." (:cloudflare-zone opts))))))
      [":cluster-host must be inside :cloudflare-zone"])

    (for [k [:digitalocean-ssh-sources :digitalocean-client-sources]
          :let [values (get opts k)]
          :when (or (not (sequential? values))
                    (empty? values)
                    (some (complement valid-cidr?) values))]
      (str k " must be a non-empty list of IPv4 CIDRs"))
    (for [k [:digitalocean-ssh-sources :digitalocean-client-sources]
          :when (some #(= "0.0.0.0/0" (str %)) (get opts k))]
      (str k " must not contain 0.0.0.0/0; administrative and database ingress stay scoped"))

    (when-not (positive-int? (:postgres-version opts))
      [":postgres-version must be a PostgreSQL major version integer such as 17"])
    (when (and (integer? (:postgres-version opts)) (< (:postgres-version opts) 15))
      [":postgres-version must be 15 or later; the topology relies on quorum synchronous commit and pg_rewind"])

    (for [k [:patroni-package-version :pgbackrest-package-version]
          :let [v (get opts k)]
          :when (and (not (placeholder? v))
                     (not (re-matches deb-version-re (str v))))]
      (str k " must be a full Debian package version such as 4.1.5-1.pgdg24.04+1"))
    (when-not (or (placeholder? (:etcd-version opts))
                  (re-matches etcd-version-re (str (:etcd-version opts))))
      [":etcd-version must be an exact vX.Y.Z release tag"])
    (when-not (or (placeholder? (:etcd-sha256 opts))
                  (re-matches sha256-re (str (:etcd-sha256 opts))))
      [":etcd-sha256 must be the lowercase hex SHA-256 of the linux-amd64 release tarball"])
    (when-not (or (placeholder? (:haproxy-version opts))
                  (re-matches #"^[0-9]+\.[0-9]+$" (str (:haproxy-version opts))))
      [":haproxy-version must be a distribution major.minor series such as 2.8"])

    (for [k [:postgres-database :postgres-admin-user :postgres-replication-user]
          :let [v (get opts k)]
          :when (and (not (placeholder? v))
                     (not (re-matches identifier-re (str v))))]
      (str k " must be an unquoted lowercase SQL identifier"))
    (when (and (not (placeholder? (:postgres-admin-user opts)))
               (= (str (:postgres-admin-user opts))
                  (str (:postgres-replication-user opts))))
      [":postgres-replication-user must differ from :postgres-admin-user"])

    (when-not (or (placeholder? (:backup-stanza opts))
                  (re-matches stanza-re (str (:backup-stanza opts))))
      [":backup-stanza must be a short lowercase pgBackRest stanza name"])
    (when-not (or (placeholder? (:backup-r2-endpoint opts))
                  (re-matches https-re (str (:backup-r2-endpoint opts))))
      [":backup-r2-endpoint must be an https:// origin"])
    (when-not (or (placeholder? (:backup-r2-prefix opts))
                  (re-matches prefix-re (str (:backup-r2-prefix opts))))
      [":backup-r2-prefix must be a relative object-key prefix"])
    (when (and (not (placeholder? (:backup-r2-bucket opts)))
               (not (placeholder? (:r2-bucket opts)))
               (= (str (:backup-r2-bucket opts)) (str (:r2-bucket opts))))
      [":backup-r2-bucket must not be the OpenTofu state bucket; backups and state do not share a blast radius"])

    (for [k (concat [:cluster-nodes :postgres-port :patroni-ttl
                     :patroni-loop-wait :patroni-retry-timeout
                     :patroni-synchronous-node-count :backup-retention-full
                     :restore-check-max-age-hours :restore-check-max-lag-seconds
                     :heartbeat-retention-days :cloudflare-record-ttl
                     :client-connect-timeout-seconds]
                    exclusive-port-keys)
          :when (not (positive-int? (get opts k)))]
      (str k " must be a positive integer"))
    (distinct-port-errors opts)
    ;; Cloudflare accepts 1 (automatic) or 60..86400. A short explicit TTL is
    ;; what lets a replaced node leave the endpoint's address set quickly.
    (when-not (or (= 1 (:cloudflare-record-ttl opts))
                  (<= 60 (or (:cloudflare-record-ttl opts) 0) 86400))
      [":cloudflare-record-ttl must be 1 (automatic) or between 60 and 86400"])

    ;; The endpoint resolves to every node, so a client may try an address whose
    ;; machine is powered off. That address does not refuse the connection, it
    ;; black-holes the SYN, and libpq's default is to wait out the OS TCP retry
    ;; — about two minutes — before trying the next one. This is the value the
    ;; documentation and the acceptance probe both use; it is desired state
    ;; rather than folklore precisely because getting it wrong turns a
    ;; survivable node loss into an outage for a third of new connections.
    (when-not (<= 1 (or (:client-connect-timeout-seconds opts) 0) 30)
      [(str ":client-connect-timeout-seconds must be between 1 and 30; it "
            "bounds how long a client waits on a powered-off node's address "
            "before trying the next one in the endpoint's record set")])

    (when-not (< 0 (or (:patroni-synchronous-node-count opts) 0) utils/node-count)
      [(str ":patroni-synchronous-node-count must be between 1 and "
            (dec utils/node-count)
            "; requiring every standby to acknowledge stalls writes when one node is lost")])
    (when-not (and (integer? (:patroni-loop-wait opts))
                   (integer? (:patroni-ttl opts))
                   (< (* 2 (:patroni-loop-wait opts)) (:patroni-ttl opts)))
      [":patroni-ttl must exceed twice :patroni-loop-wait, or the leader lock can expire between health checks"])

    (for [k [:backup-oncalendar :restore-check-oncalendar :heartbeat-oncalendar]
          :let [v (get opts k)]
          :when (and (not (placeholder? v))
                     (not (re-matches oncalendar-re (str v))))]
      (str k " must be a systemd OnCalendar expression"))

    ;; The verified restore asserts that a heartbeat written after the last
    ;; backup survived the round trip through the archive. Its tolerance has to
    ;; leave room for `archive_timeout` plus the restore itself, or the check
    ;; fails on a healthy cluster and stops meaning anything.
    (when-not (< 120 (or (:restore-check-max-lag-seconds opts) 0))
      [(str ":restore-check-max-lag-seconds must exceed 120; below that it "
            "fails on a healthy cluster, because a segment is only archived "
            "once archive_timeout elapses")]))))

(defn secret-errors
  ([opts] (secret-errors opts slots))
  ([opts selected]
   (map #(str "required credential is not set: " (green-cli/par-name %))
        (distinct
         (missing opts (concat own-secrets
                               (mapcat #(get (entry opts %) :secrets []) selected)))))))
