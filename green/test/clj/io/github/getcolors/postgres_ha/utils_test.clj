(ns io.github.getcolors.postgres-ha.utils-test
  (:require [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.postgres-ha.utils :as utils]))

(deftest par-lookup-names-the-shared-credential-namespace
  (is (= "{{ lookup('env','COLORS_PAR_POSTGRES_ADMIN_PASSWORD') }}"
         (utils/par-lookup :postgres-admin-password)))
  (testing "it renders the expression, never a value"
    (is (not (re-find #"secret|password=" (utils/par-lookup :backup-r2-secret-access-key))))))

(deftest endpoint-host-strips-what-pgbackrest-will-not-take
  (testing "pgBackRest wants a bare host, and an https:// prefix makes it fail
            with a DNS error that names a host containing a slash"
    (is (= "account.r2.cloudflarestorage.com"
           (utils/endpoint-host "https://account.r2.cloudflarestorage.com")))
    (is (= "account.r2.cloudflarestorage.com"
           (utils/endpoint-host "https://account.r2.cloudflarestorage.com/")))
    (is (= "account.r2.cloudflarestorage.com"
           (utils/endpoint-host "account.r2.cloudflarestorage.com")))))

(deftest repo-path-is-absolute-inside-the-bucket
  (is (= "/postgres-ha-digitalocean" (utils/repo-path "postgres-ha-digitalocean")))
  (is (= "/postgres-ha-digitalocean" (utils/repo-path "/postgres-ha-digitalocean")))
  (is (= "/" (utils/repo-path ""))))
