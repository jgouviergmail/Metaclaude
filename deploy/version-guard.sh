#!/usr/bin/env bash
#
# version-guard.sh <previous> <candidate>
#
# Exit 0 when <candidate> is a strictly greater semver than <previous>;
# exit 1 with a message otherwise. This is the whole comparison the CI
# version-guard job runs on every push to main — kept as its own script so
# deploy/check.sh can prove it rejects what it must (equal versions, a
# downgrade, a lexical trap like 0.9.9 vs 0.10.0) instead of trusting a
# comparison buried in workflow YAML that nothing ever exercises.

set -Eeuo pipefail

usage() { echo "usage: version-guard.sh <previous> <candidate>" >&2; exit 2; }
[ $# -eq 2 ] || usage

# Numeric x.y.z only. Anything else is refused rather than guessed at: the
# two callers both read versions this repository itself declares. Validation
# happens in the main shell on purpose — inside $(...) an exit only kills the
# subshell and the empty result would corrupt the comparison below.
[[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || {
  echo "version-guard: \"$1\" is not a numeric x.y.z version" >&2
  exit 2
}
p_major="${BASH_REMATCH[1]}" p_minor="${BASH_REMATCH[2]}" p_patch="${BASH_REMATCH[3]}"
[[ "$2" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || {
  echo "version-guard: \"$2\" is not a numeric x.y.z version" >&2
  exit 2
}
c_major="${BASH_REMATCH[1]}" c_minor="${BASH_REMATCH[2]}" c_patch="${BASH_REMATCH[3]}"

# Numeric comparison, field by field — string comparison would call 0.10.0
# smaller than 0.9.9 and this guard exists precisely to not do that.
if [ "$c_major" -gt "$p_major" ]; then exit 0; fi
if [ "$c_major" -lt "$p_major" ]; then
  echo "version-guard: $2 is lower than $1 — a push to main must increase the version" >&2
  exit 1
fi
if [ "$c_minor" -gt "$p_minor" ]; then exit 0; fi
if [ "$c_minor" -lt "$p_minor" ]; then
  echo "version-guard: $2 is lower than $1 — a push to main must increase the version" >&2
  exit 1
fi
if [ "$c_patch" -gt "$p_patch" ]; then exit 0; fi
if [ "$c_patch" -lt "$p_patch" ]; then
  echo "version-guard: $2 is lower than $1 — a push to main must increase the version" >&2
  exit 1
fi

echo "version-guard: version is still $1 — every push to main bumps it (node deploy/bump.mjs patch|minor)" >&2
exit 1
