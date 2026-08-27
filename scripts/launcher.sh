#!/usr/bin/env bash
# What the copied payloads do in the environments they actually land in.
#
# The launchers are the files in this repository the unit suites cannot reach:
# in a project each is a standalone script with no library but the one it
# resolves for itself. Everything asserted here is about that. Green carries
# the full battery; red and blue get the same standalone smokes — an unpinned
# copy refuses loudly, a LIB_ROOT copy builds — because their resolution logic
# is what a deployment actually runs.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-postgres-ha-green/green"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
checks=0
fail() { echo "launcher: FAIL — $*" >&2; exit 1; }
ok() { checks=$((checks + 1)); echo "  ok — $*"; }

[ -f "$launcher" ] || fail 'the payload launcher is missing'

grep -q 'io.github.getcolors.postgres-ha.workflow/workflow' "$launcher" \
  || fail 'lifecycle commands do not dispatch to the library workflow'
grep -q 'io.github.getcolors.postgres-ha.operator/run' "$launcher" \
  || fail 'operator commands bypass tested code'
# Naming a tool in the usage text is documentation; running one is logic. The
# patterns below are what running one looks like — the launcher must not build
# an argv, shell out, or render anything.
for bad in 'defn.*-step' 'tofu/' 'babashka.process' 'ProcessBuilder' '"ssh"' 'selmer'; do
  ! grep -qE "$bad" "$launcher" || fail "the launcher carries package logic: $bad"
done
ok 'dispatches to the library and holds no lifecycle or cluster logic'

grep -qE '\(def \^:private postgres-ha-sha (nil|"[0-9a-f]{40}")\)' "$launcher" \
  || fail 'invalid or missing pin site'
[ "$(grep -cE '\(def \^:private postgres-ha-sha ' "$launcher")" -eq 1 ] \
  || fail 'more than one pin site'
ok 'has exactly one managed immutable pin site'

mkdir "$tmp/bare"
cp "$launcher" "$tmp/bare/green"; chmod +x "$tmp/bare/green"
if grep -q '(def \^:private postgres-ha-sha nil)' "$launcher"; then
  out=$(cd "$tmp/bare" && ./green build 2>&1 || true)
  grep -q POSTGRES_HA_LIB_ROOT <<<"$out" \
    || fail 'an unstamped launcher did not explain the working-tree override'
  ok 'unstamped payload fails with an actionable working-tree override'
else
  ok 'payload carries a real pushed package commit'
fi

mkdir "$tmp/project"
cp "$launcher" "$tmp/project/green"; chmod +x "$tmp/project/green"
cp "$root/test/fixtures/colors.yml" "$tmp/project/colors.yml"
(cd "$tmp/project" && POSTGRES_HA_LIB_ROOT="$root" ./green build >/dev/null) \
  || fail 'the working-tree override did not build'
[ -f "$tmp/project/.colors/postgres-ha-fixture/postgres-ha-infrastructure/main.tf" ] \
  || fail 'a copied payload rendered nothing'
[ -f "$tmp/project/.colors/postgres-ha-fixture/postgres-ha-cluster/templates/patroni.yml.j2" ] \
  || fail 'a copied payload rendered no cluster configuration'
ok 'working-tree override renders a complete tree from a copied payload'

mkdir -p "$tmp/project/deep/path"
(cd "$tmp/project/deep/path" && POSTGRES_HA_LIB_ROOT="$root" ../../green build >/dev/null) \
  || fail 'the upward desired-state search failed'
ok 'finds colors.yml by walking upward'

out=$(cd "$tmp/project" && POSTGRES_HA_LIB_ROOT="$root" ./green nonsense 2>&1 || true)
grep -q Usage <<<"$out" || fail 'an unknown command printed no usage'
ok 'an unknown command prints usage rather than guessing'

for verb in build create delete status switchover failover backup verify-restore psql; do
  grep -q "\"$verb\"" "$launcher" || fail "the command $verb is not dispatchable"
done
ok 'every lifecycle and operator command is dispatchable'

# The profile keys remote state and the backup repository path. A launcher that
# let the environment override it could point one deployment at another's.
out=$(cd "$tmp/project" && POSTGRES_HA_LIB_ROOT="$root" \
        COLORS_PAR_PROFILE=somebody-else ./green build 2>&1 || true)
grep -qi 'profile' <<<"$out" || fail 'COLORS_PAR_PROFILE was not refused'
[ ! -d "$tmp/project/.colors/somebody-else" ] || fail 'COLORS_PAR_PROFILE redirected the work directory'
ok 'refuses the COLORS_PAR_PROFILE state-redirection overlay'

# A build must not need a credential, or it stops being the safe way to review
# a colors.yml edit on a fresh checkout.
out=$(cd "$tmp/project" && env -i PATH="$PATH" HOME="$HOME" \
        POSTGRES_HA_LIB_ROOT="$root" ./green build 2>&1) \
  || fail "build needs credentials it should not: $out"
ok 'builds with an empty environment'

for colour in green red blue; do
  [ -L "$root/$colour/$colour" ] \
    && [ "$(readlink "$root/$colour/$colour")" = "../skills/package-postgres-ha-$colour/$colour" ] \
    || fail "the $colour colour entry point is not the payload symlink"
done
ok 'every colour entry point is the payload itself'

# --- red ---------------------------------------------------------------------
red_launcher="$root/skills/package-postgres-ha-red/red"
[ -f "$red_launcher" ] || fail 'the red payload launcher is missing'
mkdir "$tmp/red-bare"
cp "$red_launcher" "$tmp/red-bare/red"; chmod +x "$tmp/red-bare/red"
if grep -q '"package-postgres-ha-red": null,' "$red_launcher"; then
  out=$(cd "$tmp/red-bare" && ./red build 2>&1 || true)
  grep -q POSTGRES_HA_LIB_ROOT <<<"$out" \
    || fail 'an unstamped red payload did not explain the working-tree override'
  ok 'unstamped red payload fails with an actionable working-tree override'
else
  ok 'red payload carries a real pushed package commit'
fi
mkdir "$tmp/red-project"
cp "$red_launcher" "$tmp/red-project/red"; chmod +x "$tmp/red-project/red"
cp "$root/test/fixtures/colors.yml" "$tmp/red-project/colors.yml"
(cd "$tmp/red-project" && POSTGRES_HA_LIB_ROOT="$root" ./red build >/dev/null) \
  || fail 'the red working-tree override did not build'
[ -f "$tmp/red-project/.colors/postgres-ha-fixture/postgres-ha-infrastructure/main.tf" ] \
  || fail 'a copied red payload rendered nothing'
ok 'red working-tree override renders a complete tree from a copied payload'

# --- blue --------------------------------------------------------------------
blue_launcher="$root/skills/package-postgres-ha-blue/blue"
[ -f "$blue_launcher" ] || fail 'the blue payload launcher is missing'
mkdir "$tmp/blue-bare"
cp "$blue_launcher" "$tmp/blue-bare/blue"; chmod +x "$tmp/blue-bare/blue"
if grep -q '^# dependencies = \[\]$' "$blue_launcher"; then
  out=$(cd "$tmp/blue-bare" && ./blue build 2>&1 || true)
  grep -q POSTGRES_HA_LIB_ROOT <<<"$out" \
    || fail 'an unstamped blue payload did not explain the working-tree override'
  ok 'unstamped blue payload fails with an actionable working-tree override'
else
  ok 'blue payload carries a real pushed package commit'
fi
mkdir "$tmp/blue-project"
cp "$blue_launcher" "$tmp/blue-project/blue"; chmod +x "$tmp/blue-project/blue"
cp "$root/test/fixtures/colors.yml" "$tmp/blue-project/colors.yml"
(cd "$tmp/blue-project" && POSTGRES_HA_LIB_ROOT="$root" ./blue build >/dev/null) \
  || fail 'the blue working-tree override did not build'
[ -f "$tmp/blue-project/.colors/postgres-ha-fixture/postgres-ha-infrastructure/main.tf" ] \
  || fail 'a copied blue payload rendered nothing'
ok 'blue working-tree override renders a complete tree from a copied payload'

echo "launcher: $checks checks passed"
