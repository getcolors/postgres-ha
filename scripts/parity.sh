#!/usr/bin/env bash
set -euo pipefail

# One desired state, three colours, byte for byte. golden.sh is green's
# regression net against the committed goldens; this is the net across colours:
# each fixture and backend variant is rendered by green, red, and blue into
# separate work directories and the trees must be identical — and the template
# trees each colour carries must be identical too, because the copies are the
# mechanism (red/resources and blue's embedded resources are copies of green's
# tree, not references to it).
#
# Two fixtures (keygen and opt-out, the SSH Keypair Standard's two modes) and
# two backends (local and r2, overlaid through COLORS_PAR_PROVIDER_BACKEND the
# way golden.sh does it): parity means every rendered byte agrees in every
# colour on all four.
#
# Renders resolve each colour's package from this working tree (the
# POSTGRES_HA_LIB_ROOT overrides), while green, red, and blue stay on their
# pins — a change that lands here passes parity before it is pushed or pinned
# anywhere.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

build_variant() {
  local fixture=$1 backend=$2
  local state="$root/test/fixtures/$fixture.yml"
  local variant="$backend-$fixture"
  (cd "$root/green" && env POSTGRES_HA_LIB_ROOT="$root" \
    COLORS_PAR_WORKDIR="$tmp/$variant/green" COLORS_PAR_PROVIDER_BACKEND="$backend" \
    ./green build -f "$state" >/dev/null)
  (cd "$root/red" && env POSTGRES_HA_LIB_ROOT="$root/red" \
    COLORS_PAR_WORKDIR="$tmp/$variant/red" COLORS_PAR_PROVIDER_BACKEND="$backend" \
    ./red build -f "$state" >/dev/null)
  (cd "$root/blue" && env COLORS_PAR_WORKDIR="$tmp/$variant/blue" COLORS_PAR_PROVIDER_BACKEND="$backend" \
    uv run python -m package_postgres_ha_blue build -f "$state" >/dev/null)
  diff -r "$tmp/$variant/green" "$tmp/$variant/red"
  diff -r "$tmp/$variant/green" "$tmp/$variant/blue"
}

for fixture in colors optout; do
  for backend in local r2; do
    build_variant "$fixture" "$backend"
  done
done

diff -r "$root/green/src/resources/io/github/getcolors/postgres-ha" "$root/red/resources"
diff -r "$root/green/src/resources/io/github/getcolors/postgres-ha" "$root/blue/src/package_postgres_ha_blue/resources"

echo "green, red, and blue postgres-ha artifacts are byte-identical"
