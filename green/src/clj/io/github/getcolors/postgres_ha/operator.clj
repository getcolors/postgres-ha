(ns io.github.getcolors.postgres-ha.operator
  "Day-two verbs, dispatched over SSH to a node or straight at the endpoint.

  These deliberately hold no cluster logic of their own: `status`, `failover`
  and `switchover` are `patronictl`, `backup` and `verify-restore` are the
  same two scripts the systemd timers run. Anything that reimplemented part of
  Patroni here would be a second, untested opinion about the cluster's state
  that only runs when a human is watching.

  The launcher is a thin dispatcher, so all of this lives in the library where
  the test suite reaches it."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [green.cli :as green-cli]
            [green.process :as process]
            [io.github.getcolors.postgres-ha.tools :as tools]
            [io.github.getcolors.postgres-ha.utils :as utils]
            [io.github.getcolors.postgres-ha.validate :as validate]))

(def kinds #{:status :failover :switchover :backup :verify-restore :psql})

(def usage
  (str "Usage: green <status|failover|switchover|backup|verify-restore|psql> "
       "[--node N] [-f|--file colors.yml] [-- extra args]\n"
       "\n"
       "  status          patronictl list — members, roles, replication lag\n"
       "  switchover      planned handover to a healthy standby\n"
       "  failover        unplanned promotion; use when the leader is gone\n"
       "  backup          run the pgBackRest full backup now, on the leader\n"
       "  verify-restore  run the verified restore now, on a standby\n"
       "  psql            psql against <cluster-host> through the primary port\n"
       "\n"
       "  --node N        which node to dispatch through (default 1); pick a\n"
       "                  live one when the cluster is degraded"))

(defn- patronictl [& args]
  (concat ["patronictl" "-c" "/etc/patroni/patroni.yml"] args))

(defn remote-command
  "The argv run on the node, before quoting.

  `psql` goes through the node's own HAProxy loopback bind rather than
  straight at the local PostgreSQL: the node the operator happened to pick may
  be a standby, and a read-only session that looks like a primary session is
  the worst possible answer to `green psql`. It also means the password is
  typed at psql's prompt instead of being placed in an argv, where `ps` would
  show it to every user on the machine."
  [kind opts extra]
  (case kind
    :status (patronictl "list")
    :switchover (concat (patronictl "switchover" "--force") extra)
    :failover (concat (patronictl "failover" "--force") extra)
    :backup ["/usr/local/bin/postgres-ha-backup"]
    :verify-restore ["/usr/local/bin/postgres-ha-restore-check"]
    :psql (concat ["psql" "-h" "127.0.0.1"
                   "-p" (str (:haproxy-primary-port opts))
                   "-U" (str (:postgres-admin-user opts))
                   "-d" (str (:postgres-database opts))]
                  extra)))

(defn ssh-command
  "Dispatch through the `~/.ssh/config` alias the local stage manages, so the
  identity file, user and host-key policy are configured in exactly one place
  and this never grows its own copy of them."
  [opts ordinal remote tty?]
  (concat ["ssh" "-F" (str (io/file (System/getProperty "user.home") ".ssh/config"))]
          (when tty? ["-t"])
          ["--" (tools/ssh-alias opts ordinal)
           (str/join " " (map process/posix-quote remote))]))

(defn command
  [kind opts ordinal extra]
  (vec (ssh-command opts ordinal (remote-command kind opts extra) (= :psql kind))))

(defn parse-args
  "Split `--node N` out of the argument vector; everything after `--`, and
  anything left over, is forwarded to the underlying tool."
  [args]
  (loop [remaining (vec args) ordinal 1 extra []]
    (cond
      (empty? remaining) {:ordinal ordinal :extra extra}

      (= "--" (first remaining))
      {:ordinal ordinal :extra (into extra (rest remaining))}

      (= "--node" (first remaining))
      (if-let [n (parse-long (str (second remaining)))]
        (recur (drop 2 remaining) n extra)
        {:error "--node needs an integer node ordinal"})

      :else (recur (rest remaining) ordinal (conj extra (first remaining))))))

(def inherit-run process/run-inherit)

(defn run
  ([state-file kind args] (run state-file kind args inherit-run (System/getenv)))
  ([state-file kind args runner env]
   (try
     (let [file (io/file state-file)]
       (cond
         (not (contains? kinds kind)) {:green/exit 2 :green/err usage}

         (not (.exists file))
         {:green/exit 2 :green/err (str "desired state file not found: " file)}

         :else
         (let [opts (-> (green-cli/read-state file (slurp file))
                        (assoc :green/state-file (.getAbsolutePath file))
                        (green-cli/read-pars env))
               {:keys [ordinal extra error]} (parse-args args)
               errors (concat (validate/env-errors env)
                              (validate/state-errors opts)
                              (when error [error])
                              (when (and ordinal
                                         (not (<= 1 ordinal utils/node-count)))
                                [(str "--node must be between 1 and "
                                      utils/node-count)]))]
           (if (seq errors)
             {:green/exit 2 :green/err (str/join "\n" errors)}
             (let [{:keys [exit err]} (runner (command kind opts ordinal extra))]
               (cond-> {:green/exit (if (zero? exit) 0 (max 1 exit))}
                 (and (not (zero? exit)) (not-empty err)) (assoc :green/err err)))))))
     (catch Throwable t
       {:green/exit 2 :green/err (or (ex-message t) (str (class t)))}))))
