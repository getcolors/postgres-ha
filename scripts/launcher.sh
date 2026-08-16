#!/usr/bin/env bash
# What the copied payload does in the environments it actually lands in.
#
# The launcher is the one file in this repository the unit suite cannot reach:
# in a project it is a standalone babashka script with no classpath but the one
# it builds for itself. Everything asserted here is about that.
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

[ -L "$root/green" ] && [ "$(readlink "$root/green")" = skills/package-postgres-ha-green/green ] \
  || fail 'the repository root green is not the payload symlink'
ok 'the repository entry point is the payload itself'

echo "launcher: $checks checks passed"
