(ns io.github.getcolors.postgres-ha.utils
  "Launcher contract and deterministic topology helpers.

  Everything here is a pure function of desired state. The topology is derived
  rather than configured: three nodes with stable ordinals and stable droplet
  names, so an OpenTofu address and an inventory host name never move because
  a list was reordered. The `~/.ssh/config` aliases are the Compute Cluster
  Standard's, derived by ONCE and wrapped in `tools/ssh-alias`."
  (:require [clojure.string :as str]))

(def contract
  "Minimum library contract a copied launcher requires. Bumped when the
  launcher and library must move together."
  1)

(def node-count
  "The only supported cluster size. Three is what makes a quorum store
  colocatable and a quorum-commit standby set meaningful; two cannot elect and
  four is outside the authorized machine budget."
  3)

(defn ordinals
  "1..node-count. The one place the node range is produced."
  []
  (range 1 (inc node-count)))

(defn base-name
  [opts]
  (or (not-empty (str (:digitalocean-name opts))) "postgres-ha"))

(defn node-name
  "The droplet name for ordinal `n`, also the Ansible inventory host name and
  the Patroni member name. One string for all three keeps `patronictl list`,
  `tofu state list` and the inventory mutually greppable."
  [opts n]
  (str (base-name opts) "-" n))

(defn par-lookup
  "The Ansible expression that reads a credential at play time.

  Rendered into generated files instead of the value, so a secret reaches a
  host through the process environment and never through a file on disk here."
  [k]
  (format "{{ lookup('env','COLORS_PAR_%s') }}"
          (-> (name k) (str/replace "-" "_") str/upper-case)))

(defn endpoint-host
  "The S3 endpoint host pgBackRest wants: it takes a bare host, not a URL."
  [endpoint]
  (-> (str endpoint)
      (str/replace #"^https?://" "")
      (str/replace #"/.*$" "")))

(defn repo-path
  "pgBackRest's repository path is absolute inside the bucket."
  [prefix]
  (let [p (str/replace (str prefix) #"^/+" "")]
    (if (str/blank? p) "/" (str "/" p))))
