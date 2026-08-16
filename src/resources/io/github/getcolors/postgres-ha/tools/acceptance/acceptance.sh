#!/usr/bin/env bash
# Post-convergence health checks for <{ cluster-name }>.
#
# Everything here is asserted from outside the cluster, over the same client
# endpoint and the same SSH aliases an operator would use. Nothing reads a file
# the converge wrote to decide whether the converge worked.
set -uo pipefail

HOST="<{ cluster-host }>"
PRIMARY_PORT=<{ haproxy-primary-port }>
REPLICA_PORT=<{ haproxy-replica-port }>
DB="<{ postgres-database }>"
USER="<{ postgres-admin-user }>"
STANZA="<{ backup-stanza }>"
NODES=<{ cluster-nodes }>
MAX_AGE_HOURS=<{ restore-check-max-age-hours }>
SSH_CONFIG="$HOME/.ssh/config"
ALIASES=(<% for node in nodes %>"<{ node.alias }>" <% endfor %>)

failures=0
checks=0

ok()   { checks=$((checks + 1)); printf '  ok   — %s\n' "$*"; }
bad()  { checks=$((checks + 1)); failures=$((failures + 1)); printf '  FAIL — %s\n' "$*" >&2; }
note() { printf '         %s\n' "$*"; }

pg() {
  local port=$1 sql=$2
  psql -X -q -tA -w \
    -h "$HOST" -p "$port" -U "$USER" -d "$DB" \
    -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null
}

# The cluster is reachable through any live node. Trying them in turn is what
# keeps acceptance meaningful immediately after a failover, when the node that
# used to answer may be exactly the one that is gone.
on_node() {
  local remote="$1" alias
  for alias in "${ALIASES[@]}"; do
    if out=$(ssh -F "$SSH_CONFIG" -o BatchMode=yes -o ConnectTimeout=10 \
               -- "$alias" "$remote" 2>/dev/null); then
      printf '%s' "$out"
      return 0
    fi
  done
  return 1
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
archived=$(pg "$PRIMARY_PORT" 'SELECT archived_count FROM pg_stat_archiver')
last_failed=$(pg "$PRIMARY_PORT" "SELECT coalesce(last_failed_wal, '')::text FROM pg_stat_archiver")
archive_cmd=$(pg "$PRIMARY_PORT" "SELECT current_setting('archive_command')")
if [ "${archived:-0}" -ge 1 ] 2>/dev/null && [ -z "$last_failed" ]; then
  ok "WAL archiving is continuous: $archived segments archived, none failed"
  note "archive_command = $archive_cmd"
  note "$(pg "$PRIMARY_PORT" "SELECT 'last archived ' || last_archived_wal || ' at ' || last_archived_time FROM pg_stat_archiver")"
else
  bad "WAL archiving is not healthy: archived=${archived:-0} last_failed=${last_failed:-none}"
fi

# --- 7. a snapshot has landed in the object store --------------------------
info=$(on_node "sudo -n -u postgres pgbackrest --stanza=$STANZA --output=json info")
if [ -n "$info" ]; then
  backups=$(printf '%s' "$info" | jq '[.[].backup[]] | length')
  archive_max=$(printf '%s' "$info" | jq -r '[.[].archive[].max] | map(select(. != null)) | first // ""')
  repo_status=$(printf '%s' "$info" | jq -r '.[].status.message')
  if [ "${backups:-0}" -ge 1 ] && [ -n "$archive_max" ] && [ "$repo_status" = ok ]; then
    ok "the backup repository holds $backups backup(s) and WAL up to $archive_max"
    note "$(printf '%s' "$info" | jq -r '.[].backup[] | "\(.type) \(.label) size=\(.info.repository.size)B"' | tail -3 | tr '\n' '|')"
  else
    bad "backup repository is not healthy: backups=${backups:-0} archive_max=${archive_max:-none} status=$repo_status"
  fi
else
  bad "no node could read the backup repository"
fi

# --- 8. the verified restore has actually run and passed -------------------
stamp=$(on_node "cat /var/lib/postgresql/.postgres-ha-restore-check 2>/dev/null || true")
if [ -n "$stamp" ]; then
  when=$(printf '%s' "$stamp" | awk '{print $1}')
  age=$(( ( $(date -u +%s) - $(date -u -d "$when" +%s) ) / 3600 ))
  if [ "$age" -le "$MAX_AGE_HOURS" ]; then
    ok "the verified restore passed ${age}h ago, inside the ${MAX_AGE_HOURS}h limit"
    note "$stamp"
  else
    bad "the last verified restore is ${age}h old, above the ${MAX_AGE_HOURS}h limit"
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

printf '\nacceptance: %d checks, %d failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
