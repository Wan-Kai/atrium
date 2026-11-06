#!/bin/sh
# Replaces /Applications/Atrium.app with a packaged build and reopens it (docs/install-app.md).
#
# Run it from a shell: it hands the work to a one-shot launchd job and returns at once. The job must
# not be a child of Atrium, because quitting Atrium kills every process below it, including the pi
# session that asked for the reinstall. The job waits a moment, quits Atrium, keeps the old bundle
# as a backup, copies the new one in, checks its signature and opens it; a failed copy puts the
# backup back. `--run` is how the job calls this script again; do not use it by hand.
set -eu

label="dev.atrium.install-app"
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/$label.plist"
logs="$HOME/Library/Logs/Atrium"
log="$logs/install-app.log"
guard="$logs/install-app.last"
repo="$(cd "$(dirname "$0")/.." && pwd)"
app="/Applications/Atrium.app"
main_pattern='Atrium.app/Contents/MacOS/Atrium$'

run=0
delay=12
source_app="$repo/apps/desktop/out/Atrium-darwin-$(uname -m)/Atrium.app"
while [ $# -gt 0 ]; do
  case "$1" in
    --run) run=1 ;;
    --source) shift; source_app="$1" ;;
    --wait) shift; delay="$1" ;;
    *) echo "usage: $0 [--source <Atrium.app>] [--wait <seconds>]" >&2; exit 2 ;;
  esac
  shift
done

if [ "$run" -eq 0 ]; then
  if [ ! -d "$source_app" ]; then
    echo "no packaged app at $source_app" >&2
    echo "run pnpm package first (ATRIUM_CODESIGN_IDENTITY names the signing certificate)" >&2
    exit 1
  fi
  mkdir -p "$logs" "$(dirname "$plist")"
  # RunAtLoad with no KeepAlive: one run per load. `launchctl submit` restarts on exit instead,
  # which looped the reinstall on 2026-11-05 (docs/install-app.md).
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$repo/scripts/install-app.sh</string>
    <string>--run</string>
    <string>--source</string>
    <string>$source_app</string>
    <string>--wait</string>
    <string>$delay</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
  plutil -lint "$plist" > /dev/null
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$guard"
  launchctl bootstrap "$domain" "$plist"
  echo "started $label: Atrium quits in ${delay}s, then $source_app replaces $app"
  helpers=$(ps -axo pid=,args= | awk '$0 ~ /Atrium Helper/ { print $1 }' | tr '\n' ' ')
  interrupted=$(ps -axo ppid=,args= | awk -v helpers="$helpers" '
    BEGIN { n = split(helpers, ids, " "); for (i = 1; i <= n; i++) parent[ids[i]] = 1 }
    $2 == "pi" && ($1 in parent) { count++ }
    END { print count + 0 }')
  echo "pi sessions that will be interrupted: $interrupted"
  echo "log: $log"
  exit 0
fi

stamp() { echo "[$(date '+%F %T')] $*"; }
running() { ps -axo args= | grep -q "$main_pattern"; }

# Disarm first: with the plist gone a respawn can only hit the guard below.
rm -f "$plist" && stamp "removed $plist"
if [ -f "$guard" ]; then
  age=$(( $(date +%s) - $(cat "$guard") ))
  if [ "$age" -lt 600 ]; then
    stamp "ABORT: ran ${age}s ago, refusing to reinstall again"
    exit 0
  fi
fi
date +%s > "$guard"

stamp "=== start; source $source_app"
if [ ! -d "$source_app" ]; then
  stamp "ABORT: no packaged app at $source_app"
  exit 1
fi

# Whatever asked for this is about to lose its session: give it room to finish the reply.
stamp "waiting ${delay}s before quitting Atrium"
sleep "$delay"

stamp "quitting Atrium"
osascript -e 'quit app "Atrium"' > /dev/null 2>&1 || stamp "osascript quit failed"
i=0
while [ "$i" -lt 60 ]; do
  running || break
  sleep 0.5
  i=$((i + 1))
done
if running; then
  stamp "graceful quit timed out, sending TERM"
  pkill -TERM -f 'Atrium.app/Contents/MacOS/Atrium' || true
  sleep 3
fi
if running; then
  stamp "sending KILL"
  pkill -KILL -f 'Atrium.app/Contents/MacOS/Atrium' || true
  sleep 2
fi
if running; then
  stamp "ABORT: Atrium would not quit, nothing replaced"
  exit 1
fi
stamp "Atrium exited"

# A grant is tied to the designated requirement: switching to or between certificates leaves the
# old one behind, so ask once more (development.md used to spell this out inline).
tccutil reset SystemPolicyDocumentsFolder dev.atrium.app || stamp "tccutil reset exited $?"

backup="$app.bak-$(date +%Y%m%d-%H%M%S)"
stamp "backing up to $backup"
if ! mv "$app" "$backup"; then
  stamp "ABORT: backup failed"
  exit 1
fi

if ditto "$source_app" "$app"; then
  xattr -dr com.apple.quarantine "$app" 2> /dev/null || true
  if codesign --verify --deep --strict "$app"; then
    stamp "signature verifies"
  else
    stamp "WARNING: signature does not verify"
  fi
  codesign -d -r- "$app" 2>&1 | grep designated | sed 's/^/    /' || true
  stamp "replaced; backup=$backup"
  open "$app" && stamp "relaunched"
else
  stamp "copy failed, restoring backup"
  rm -rf "$app"
  mv "$backup" "$app"
  open "$app" && stamp "restored and relaunched"
fi

sleep 6
running && stamp "done: Atrium is running" || stamp "WARNING: Atrium is not running after open"
launchctl bootout "$domain/$label" > /dev/null 2>&1 || true
