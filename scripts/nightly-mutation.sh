#!/bin/sh
# Runs the whole mutation test on main, once a night (testing.md, "什么时候跑"; development.md,
# "夜间变异测试"). launchd starts it with the repository's path; it works in a worktree of its own,
# so the checkout in use is never touched. Results go to ~/Library/Logs/Atrium/mutation: the run's
# log, and latest.txt with the score and the mutants to look at. A main already tested is skipped.
set -eu

repo="$1"
work="$HOME/.cache/atrium-mutation"
results="$HOME/Library/Logs/Atrium/mutation"
mkdir -p "$results"

# One run at a time: a run still going when the next night comes keeps it.
lock="$results/.running"
if ! mkdir "$lock" 2>/dev/null; then
  echo "$(date '+%F %T') a run is still going; skipped" >> "$results/skipped.log"
  exit 0
fi
trap 'rmdir "$lock"' EXIT

commit="$(git -C "$repo" rev-parse main)"
if [ -f "$results/last-commit" ] && [ "$(cat "$results/last-commit")" = "$commit" ]; then
  exit 0
fi

if [ ! -d "$work" ]; then
  git -C "$repo" worktree add --quiet --detach "$work" main
fi
git -C "$work" checkout --quiet --force --detach "$commit"
git -C "$work" clean -fdq
# Sandboxes left by a run that was killed; tests make some folders unreadable on purpose.
for leftover in "$work/.stryker-tmp" "$work/.tmp"; do
  if [ -d "$leftover" ]; then
    chmod -R u+rwx "$leftover"
    rm -rf "$leftover"
  fi
done

cd "$work"
pnpm install --frozen-lockfile --offline > /dev/null 2>&1 || pnpm install --frozen-lockfile > /dev/null

stamp="$(date '+%Y-%m-%d')"
log="$results/$stamp.log"
started="$(date '+%F %T')"
# Keeps the Mac awake for as long as the run takes.
status=0
caffeinate -i pnpm test:mutation --force > "$log" 2>&1 || status=$?

score="$(grep -a 'All files' "$log" | tail -1 | tr -s ' ')"
{
  echo "main $commit"
  echo "started $started, ended $(date '+%F %T'), exit $status"
  echo "${score:-no score: see $log}"
  echo
  echo "Survived and timed out (each timeout must be explained):"
  node -e '
    const report = JSON.parse(require("node:fs").readFileSync("reports/stryker-incremental.json", "utf8"));
    let found = 0;
    for (const [file, { mutants }] of Object.entries(report.files)) {
      for (const m of mutants) {
        if (m.status !== "Survived" && m.status !== "Timeout") continue;
        const at = m.location.start;
        const to = String(m.replacement ?? "").replace(/\s+/g, " ").slice(0, 80);
        console.log(`${m.status} ${file}:${at.line}:${at.column} ${m.mutatorName} -> ${to}`);
        found += 1;
      }
    }
    if (found === 0) console.log("none");
  ' 2>/dev/null || echo "could not read the report"
} > "$results/latest.txt"

if [ "$status" -eq 0 ]; then
  echo "$commit" > "$results/last-commit"
fi
look="$(grep -cE '^(Survived|Timeout) ' "$results/latest.txt" || true)"
osascript -e "display notification \"exit $status, $look to look at; see latest.txt\" with title \"Atrium mutation testing\"" || true
