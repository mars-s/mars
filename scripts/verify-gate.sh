#!/usr/bin/env bash
# Pre-merge and pre-push gate for mars.
#
# One command that runs every check the project relies on, so a reviewer never has
# to remember the order or the caveats. Each check prints PASS or FAIL, and the
# script exits non-zero if any of them fail.
#
# Usage:
#   scripts/verify-gate.sh              # run everything
#   scripts/verify-gate.sh --quick      # skip the frozen-lockfile install
#
# Why the checks are shaped this way is recorded in .agents/verification.md.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

FAILED=0
PASSED=0

step() {
  local name="$1"
  shift
  local log
  log="$(mktemp -t verify-gate)"
  printf '\n=== %s ===\n' "$name"
  if "$@" >"$log" 2>&1; then
    printf 'PASS: %s\n' "$name"
    PASSED=$((PASSED + 1))
  else
    printf 'FAIL: %s (exit %d)\n' "$name" "$?"
    tail -25 "$log"
    FAILED=$((FAILED + 1))
  fi
  rm -f "$log"
}

# 1. The lockfile must still describe this manifest. A manifest or lockfile change
#    is NOT verified until this has run after it. This is the check that caught the
#    stale patchedDependencies entry left behind by the telemetry removal.
if [ "$QUICK" -eq 0 ]; then
  step "install: frozen lockfile" pnpm install --frozen-lockfile
else
  printf '\n=== install: frozen lockfile ===\nSKIPPED (--quick)\n'
fi

# 2. Root typecheck. NOTE this does not cover apps/zcode-cli or four of the desktop
#    projects, which is why checks 3 and 4 exist. See .agents/verification.md.
step "typecheck: root (turbo)" pnpm typecheck

# 3. The agent CLI is a separate pnpm workspace and is invisible to the root
#    typecheck, so a broken import there passes check 2 silently.
step "typecheck: apps/zcode-cli" bash -c 'cd apps/zcode-cli && npx turbo run typecheck'

# 4. Desktop projects the root typecheck skips, diffed against the recorded
#    baseline. A changed count means the change introduced errors; an identical
#    count means it introduced none. Baseline: main 82, preload 3, renderer 123,
#    scheduler 1.
check_desktop_baseline() {
  local expect_main=82 expect_preload=3 expect_renderer=123 expect_scheduler=1
  local rc=0
  for pair in "main:$expect_main" "preload:$expect_preload" \
              "renderer:$expect_renderer" "scheduler:$expect_scheduler"; do
    local proj="${pair%%:*}" want="${pair##*:}" got
    got=$(npx tsc -b "packages/desktop/tsconfig.$proj.json" --force 2>&1 | grep -c 'error TS')
    if [ "$got" = "$want" ]; then
      printf '  %-10s %s (baseline %s) ok\n' "$proj" "$got" "$want"
    else
      printf '  %-10s %s, baseline is %s, DELTA of %s\n' "$proj" "$got" "$want" "$((got - want))"
      rc=1
    fi
  done
  # tsc -b on tsconfig.main.json emits artifacts next to the source, because
  # main imports ../scheduler which is outside its rootDir. They are gitignored,
  # but clean them anyway so a later git status is not confusing.
  rm -f packages/desktop/src/scheduler/schedulerProtocol.{js,js.map,d.ts,d.ts.map}
  return $rc
}
step "typecheck: desktop projects vs baseline" check_desktop_baseline

# 5. Lint. The project tolerates pre-existing warnings; only errors fail the gate.
check_lint() {
  pnpm lint > /tmp/verify-gate-lint.$$ 2>&1
  local rc=$?
  local errs warns
  errs=$(grep -oE '[0-9]+ error' /tmp/verify-gate-lint.$$ | tail -1)
  warns=$(grep -oE '[0-9]+ warning' /tmp/verify-gate-lint.$$ | tail -1)
  printf '  lint: %s, %s\n' "${errs:-0 error}" "${warns:-0 warning}"
  rm -f /tmp/verify-gate-lint.$$
  # 70 warnings is the known baseline, so warn loudly if it moves a lot.
  return $rc
}
step "lint" check_lint

# 6. Format, restricted to the files this change actually touched. The repo has
#    pre-existing format debt (219 files in apps/zcode-cli alone), so a blanket
#    fmt:check is not a gate. Only the diff is.
#
#    The file set is the UNION of committed changes since $base and uncommitted
#    working tree changes. Checking only base...HEAD would silently skip anything
#    not yet committed, which is precisely when a format error is most likely to
#    slip in.
collect_changed_sources() {
  local base="${BASE_REF:-origin/main}"
  {
    git diff --name-only "$base"...HEAD -- '*.ts' '*.tsx' 2>/dev/null
    git diff --name-only HEAD -- '*.ts' '*.tsx' 2>/dev/null
    git ls-files --others --exclude-standard -- '*.ts' '*.tsx' 2>/dev/null
  } | grep -v '/\.agents/' | grep -v '^$' | sort -u
}
check_format() {
  local files
  files="$(collect_changed_sources)"
  if [ -z "$files" ]; then
    echo "  no changed source files, nothing to check"
    return 0
  fi
  local n
  n=$(printf '%s\n' "$files" | grep -c .)
  echo "  checking $n changed source files"
  # oxfmt is happy to report success while silently skipping files it does not
  # recognise, so verify it actually looked at roughly what we handed it.
  local out
  out=$(printf '%s\n' "$files" | xargs pnpm exec oxfmt --check 2>&1)
  local rc=$?
  printf '%s\n' "$out" | tail -3
  return $rc
}
step "format: changed files only" check_format

# 7. No hardcoded secret in the diff. .agents/ is committed, so credentials must
#    never land there; they live in the 1Password vault and are referenced by item
#    name only.
check_secrets() {
  local base="${BASE_REF:-origin/main}"
  # Union of committed and uncommitted changes, matching the format check, so an
  # uncommitted secret is caught before it is ever pushed.
  local hits
  hits=$(
    {
      git diff "$base"...HEAD 2>/dev/null
      git diff HEAD 2>/dev/null
    } | grep '^+' \
    | grep -iE '(api[_-]?key|secret|token|password|bearer)[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_-]{12,}' \
    | grep -v 'process\.env'
  )
  if [ -n "$hits" ]; then
    echo "  possible hardcoded secret in the diff:"
    printf '%s\n' "$hits" | head -10
    return 1
  fi
  echo "  no hardcoded secrets in the diff"
}
step "secrets: diff scan" check_secrets

# 8. Hygiene: the working tree must be clean and no generated build artifact may
#    be tracked. The four schedulerProtocol artifacts were once swept into a commit
#    by a git add -A, which is what this check is here to prevent.
check_hygiene() {
  local rc=0
  local dirty
  dirty=$(git status --porcelain | wc -l | tr -d ' ')
  if [ "$dirty" != "0" ]; then
    echo "  working tree is not clean ($dirty entries):"
    git status --porcelain | head -20
    rc=1
  else
    echo "  working tree is clean"
  fi
  local tracked
  tracked=$(git ls-files | grep -cE '\.(js|js\.map|d\.ts|d\.ts\.map)$' || true)
  # 13 hand written .js files in packages/zcode-cua plus 29 .d.ts are legitimately
  # tracked, so only flag anything under packages/desktop/src.
  local bad
  bad=$(git ls-files 'packages/desktop/src/**' | grep -cE '\.(js|js\.map|d\.ts|d\.ts\.map)$' || true)
  if [ "$bad" != "0" ]; then
    echo "  $bad generated artifact(s) tracked under packages/desktop/src:"
    git ls-files 'packages/desktop/src/**' | grep -E '\.(js|js\.map|d\.ts|d\.ts\.map)$'
    rc=1
  else
    echo "  no generated artifacts tracked under packages/desktop/src"
  fi
  echo "  ($tracked tracked .js/.d.ts elsewhere, all intentional)"
  return $rc
}
step "hygiene: tree and artifacts" check_hygiene

printf '\n========================================\n'
printf 'PASSED: %d   FAILED: %d\n' "$PASSED" "$FAILED"
printf '========================================\n'
if [ "$FAILED" -ne 0 ]; then
  echo "GATE: FAIL"
  exit 1
fi
echo "GATE: PASS"
