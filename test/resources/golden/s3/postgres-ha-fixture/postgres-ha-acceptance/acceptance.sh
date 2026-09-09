#!/usr/bin/env bash
# Post-convergence health checks for postgres-ha-fixture.
#
# Everything here is asserted from outside the cluster, over the same client
# endpoint and the same SSH aliases an operator would use. Nothing reads a file
# the converge wrote to decide whether the converge worked.
set -uo pipefail

HOST="pg-ha.fixture.example"
PRIMARY_PORT=5432
REPLICA_PORT=5433
DB="appdb"
USER="postgres"
STANZA="main"
NODES=3
MAX_AGE_HOURS=26
CONNECT_TIMEOUT=5
SSH_CONFIG="$HOME/.ssh/config"
ALIASES=("postgres-ha-fixture-0" "postgres-ha-fixture-1" "postgres-ha-fixture-2" )

failures=0
checks=0

ok()   { checks=$((checks + 1)); printf '  ok   — %s\n' "$*"; }
bad()  { checks=$((checks + 1)); failures=$((failures + 1)); printf '  FAIL — %s\n' "$*" >&2; }
note() { printf '         %s\n' "$*"; }

# `connect_timeout` is not optional against this endpoint, and acceptance uses
# it for the same reason a client must: the name resolves to every node, and a
# node that is powered off black-holes the SYN rather than refusing it. Without
# a timeout libpq waits out the OS TCP retry — about two minutes — before
# trying the next address, so the check that is supposed to prove the endpoint
# survived a node loss would be the thing that hangs.
pg() {
  local port=$1 sql=$2
  psql -X -q -tA -w \
    -d "host=$HOST port=$port user=$USER dbname=$DB connect_timeout=$CONNECT_TIMEOUT" \
    -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null
}

# The cluster is reachable through any live node. Trying them in turn is what
# keeps acceptance meaningful immediately after a failover, when the node that
# used to answer may be exactly the one that is gone.
on_node() {
  local remote="$1" alias out
  for alias in "${ALIASES[@]}"; do
    if out=$(ssh -F "$SSH_CONFIG" -o BatchMode=yes -o ConnectTimeout=10 \
               -- "$alias" "$remote" 2>/dev/null); then
      printf '%s' "$out"
      return 0
    fi
  done
  return 1
}

# For anything whose answer is per-node rather than cluster-wide. `on_node`
# stops at the first host that answers, which is wrong for a fact only some
# nodes hold: the verified restore runs on the standbys, so asking the leader
# and stopping there reports "nobody ran it".
on_each_node() {
  local remote="$1" alias out
  for alias in "${ALIASES[@]}"; do
    if out=$(ssh -F "$SSH_CONFIG" -o BatchMode=yes -o ConnectTimeout=10 \
               -- "$alias" "$remote" 2>/dev/null); then
      [ -n "$out" ] && printf '%s\n' "$out"
    fi
  done
}

printf 'acceptance: %s\n' "$HOST"

# --- 1. the endpoint resolves to every node --------------------------------
addresses=$(getent ahostsv4 "$HOST" | awk '{print $1}' | sort -u)
count=$(printf '%s\n' "$addresses" | grep -c . || true)
if [ "$count" -eq "$NODES" ]; then
  ok "$HOST resolves to all $NODES nodes"
  note "$(printf '%s' "$addresses" | tr '\n' ' ')"
else
  bad "$HOST resolves to $count addresses, expected $NODES"
  note "$(printf '%s' "$addresses" | tr '\n' ' ')"
fi

# --- 2. the endpoint serves a read-write primary ---------------------------
recovery=$(pg "$PRIMARY_PORT" 'SELECT pg_is_in_recovery()')
if [ "$recovery" = f ]; then
  ok "port $PRIMARY_PORT reaches a read-write primary"
  note "$(pg "$PRIMARY_PORT" "SELECT 'PostgreSQL ' || current_setting('server_version') || ' on ' || coalesce(current_setting('cluster_name', true), '?')")"
else
  bad "port $PRIMARY_PORT did not reach a read-write primary (pg_is_in_recovery=${recovery:-unreachable})"
fi

# --- 3. the read-only endpoint serves a standby ----------------------------
replica_recovery=$(pg "$REPLICA_PORT" 'SELECT pg_is_in_recovery()')
if [ "$replica_recovery" = t ]; then
  ok "port $REPLICA_PORT reaches a read-only standby"
else
  bad "port $REPLICA_PORT did not reach a standby (pg_is_in_recovery=${replica_recovery:-unreachable})"
fi

# --- 4. Patroni sees one leader and three running members ------------------
cluster_json=$(on_node "patronictl -c /etc/patroni/patroni.yml list --format json")
if [ -n "$cluster_json" ]; then
  running=$(printf '%s' "$cluster_json" | jq '[.[] | select(.State == "running" or .State == "streaming")] | length')
  leaders=$(printf '%s' "$cluster_json" | jq '[.[] | select(.Role == "Leader" or .Role == "Standby Leader")] | length')
  if [ "$running" = "$NODES" ] && [ "$leaders" = 1 ]; then
    ok "Patroni reports $NODES healthy members and exactly 1 leader"
  else
    bad "Patroni reports $running healthy members and $leaders leaders, expected $NODES and 1"
  fi
  note "$(printf '%s' "$cluster_json" | jq -r '.[] | "\(.Member) \(.Role) \(.State) lag=\(."Lag in MB")"' | tr '\n' '|')"
else
  bad "no node answered patronictl"
fi

# --- 5. replication is streaming, and quorum-synchronous -------------------
streaming=$(pg "$PRIMARY_PORT" "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'")
sync=$(pg "$PRIMARY_PORT" "SELECT count(*) FROM pg_stat_replication WHERE sync_state IN ('sync', 'quorum')")
if [ "${streaming:-0}" = "$((NODES - 1))" ]; then
  ok "$streaming standbys are streaming from the primary"
else
  bad "$((NODES - 1)) streaming standbys expected, found ${streaming:-none}"
fi
if [ "${sync:-0}" -ge 1 ] 2>/dev/null; then
  ok "$sync standby(s) acknowledge synchronously; a commit is durable on more than one machine"
  note "$(pg "$PRIMARY_PORT" "SELECT string_agg(application_name || '=' || sync_state || '/' || state, ' ') FROM pg_stat_replication")"
  note "synchronous_standby_names = $(pg "$PRIMARY_PORT" "SELECT current_setting('synchronous_standby_names')")"
else
  bad "no standby is acknowledging synchronously; commits are not durable beyond the primary"
fi

# --- 6. PITR material is being archived continuously -----------------------
#
# `last_failed_wal` is sticky: it names the last segment that ever failed, not
# a current problem. It is *expected* to be set on a freshly built cluster,
# because Patroni bootstraps with archive_mode on and PostgreSQL starts
# retrying the first segment before `pgbackrest stanza-create` has run. Those
# retries never lose a segment — PostgreSQL keeps the WAL and keeps trying —
# and check 7 proves it by asserting the repository's archive range starts at
# the first segment.
#
# So the health question is not "has anything ever failed" but "did the last
# attempt succeed", which is `last_archived_time > last_failed_time`.
archived=$(pg "$PRIMARY_PORT" 'SELECT archived_count FROM pg_stat_archiver')
healthy=$(pg "$PRIMARY_PORT" "SELECT (last_archived_time IS NOT NULL AND (last_failed_time IS NULL OR last_archived_time > last_failed_time))::text FROM pg_stat_archiver")
recent=$(pg "$PRIMARY_PORT" "SELECT (now() - last_archived_time < interval '1 hour')::text FROM pg_stat_archiver")
archive_cmd=$(pg "$PRIMARY_PORT" "SELECT current_setting('archive_command')")
if [ "${archived:-0}" -ge 1 ] 2>/dev/null && [ "$healthy" = true ] && [ "$recent" = true ]; then
  ok "WAL archiving is continuous: $archived segments archived, last attempt succeeded"
  note "archive_command = $archive_cmd"
  note "$(pg "$PRIMARY_PORT" "SELECT 'last archived ' || last_archived_wal || ' at ' || last_archived_time FROM pg_stat_archiver")"
  note "$(pg "$PRIMARY_PORT" "SELECT 'archive_timeout = ' || current_setting('archive_timeout')")"
  retried=$(pg "$PRIMARY_PORT" "SELECT failed_count || ' retries of ' || coalesce(last_failed_wal, 'none') || ', last at ' || coalesce(last_failed_time::text, 'never') FROM pg_stat_archiver WHERE failed_count > 0")
  [ -n "$retried" ] && note "before the stanza existed: $retried"
else
  bad "WAL archiving is not healthy: archived=${archived:-0} last-attempt-succeeded=${healthy:-unknown} archived-within-the-hour=${recent:-unknown}"
fi

# --- 7. a snapshot has landed in the object store --------------------------
info=$(on_node "sudo -n -u postgres pgbackrest --stanza=$STANZA --output=json info")
if [ -n "$info" ]; then
  backups=$(printf '%s' "$info" | jq '[.[].backup[]] | length')
  archive_min=$(printf '%s' "$info" | jq -r '[.[].archive[].min] | map(select(. != null)) | first // ""')
  archive_max=$(printf '%s' "$info" | jq -r '[.[].archive[].max] | map(select(. != null)) | first // ""')
  repo_status=$(printf '%s' "$info" | jq -r '.[].status.message')
  if [ "${backups:-0}" -ge 1 ] && [ -n "$archive_max" ] && [ "$repo_status" = ok ]; then
    ok "the backup repository holds $backups backup(s) and WAL from $archive_min to $archive_max"
    note "$(printf '%s' "$info" | jq -r '.[].backup[] | "\(.type) \(.label) size=\(.info.repository.size)B"' | tail -3 | tr '\n' '|')"
  else
    bad "backup repository is not healthy: backups=${backups:-0} archive_max=${archive_max:-none} status=$repo_status"
  fi
  # The recovery window is only unbroken if the repository holds every segment
  # from the first one the cluster ever wrote. This is what turns the retry
  # storm reported in check 6 from a worry into a footnote.
  if [ "$archive_min" = 000000010000000000000001 ]; then
    ok "the archive is unbroken from the cluster's first WAL segment"
  else
    note "archive starts at $archive_min; expected after an expiry has run, suspicious otherwise"
  fi
else
  bad "no node could read the backup repository"
fi

# --- 8. the verified restore has actually run and passed -------------------
#
# Asked of every node, not the first that answers: the check runs on the
# standbys and never on the leader, so stopping at the leader would report that
# nobody had run it.
stamps=$(on_each_node "cat /var/lib/postgresql/.postgres-ha-restore-check 2>/dev/null")
if [ -n "$stamps" ]; then
  stamp=$(printf '%s\n' "$stamps" | sort -r | head -1)
  when=$(printf '%s' "$stamp" | awk '{print $1}')
  age=$(( ( $(date -u +%s) - $(date -u -d "$when" +%s) ) / 3600 ))
  passed=$(printf '%s\n' "$stamps" | grep -c .)
  if [ "$age" -le "$MAX_AGE_HOURS" ]; then
    ok "the verified restore passed on $passed node(s), most recently ${age}h ago, inside the ${MAX_AGE_HOURS}h limit"
    printf '%s\n' "$stamps" | while read -r line; do note "$line"; done
  else
    bad "the newest verified restore is ${age}h old, above the ${MAX_AGE_HOURS}h limit"
  fi
else
  bad "no node recorded a successful verified restore"
fi

# --- 9. a write through the endpoint reaches a standby ---------------------
token="acceptance-$(date -u +%Y%m%dT%H%M%SZ)-$$"
if pg "$PRIMARY_PORT" "INSERT INTO colors_restore_sentinel (token, node) VALUES ('$token', 'acceptance')" >/dev/null; then
  seen=0
  for _ in $(seq 1 30); do
    if [ "$(pg "$REPLICA_PORT" "SELECT count(*) FROM colors_restore_sentinel WHERE token = '$token'")" = 1 ]; then
      seen=1
      break
    fi
    sleep 1
  done
  if [ "$seen" = 1 ]; then
    ok "a row written through port $PRIMARY_PORT was readable on port $REPLICA_PORT"
  else
    bad "a row written through port $PRIMARY_PORT never appeared on port $REPLICA_PORT"
  fi
else
  bad "could not write through the client endpoint"
fi

# --- 10. every address in the record set reaches the current primary --------
#
# The endpoint's whole design is that all three addresses are correct answers,
# and that a client bounded by connect_timeout skips a dead one. Probing once
# proves nothing: glibc rotates the resolved order, so a single probe may never
# touch the address that would have failed. This probes 3 * NODES times and
# requires every one of them to arrive at a read-write primary.
probes=$(( NODES * 3 ))
worst=0
reached=0
for _ in $(seq 1 "$probes"); do
  t0=$(date +%s%N)
  if [ "$(pg "$PRIMARY_PORT" 'SELECT pg_is_in_recovery()')" = f ]; then
    reached=$((reached + 1))
  fi
  ms=$(( ( $(date +%s%N) - t0 ) / 1000000 ))
  [ "$ms" -gt "$worst" ] && worst=$ms
done
budget=$(( (CONNECT_TIMEOUT * (NODES - 1) + 10) * 1000 ))
if [ "$reached" -eq "$probes" ] && [ "$worst" -le "$budget" ]; then
  ok "all $probes endpoint probes reached a read-write primary, worst ${worst}ms"
  note "connect_timeout=${CONNECT_TIMEOUT}s bounds the wait on any address whose node is gone"
else
  bad "$reached of $probes endpoint probes reached a read-write primary, worst ${worst}ms against a ${budget}ms budget"
fi

printf '\nacceptance: %d checks, %d failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
