#!/bin/sh
# Installs, or with `uninstall` removes, the launchd job that runs the mutation test on main every
# night at 02:00 (development.md, "夜间变异测试"). The job runs main's own copy of
# nightly-mutation.sh, whatever branch this checkout is on. A Mac asleep at 02:00 runs it when it
# wakes. The Node that runs this script is the one the job uses.
set -eu

label="com.atrium.nightly-mutation"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

launchctl bootout "$domain/$label" 2>/dev/null || true
if [ "${1:-}" = "uninstall" ]; then
  rm -f "$plist"
  echo "removed $label"
  exit 0
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
node_bin="$(dirname "$(command -v node)")"
logs="$HOME/Library/Logs/Atrium/mutation"
mkdir -p "$logs" "$(dirname "$plist")"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>git -C "\$0" show main:scripts/nightly-mutation.sh | /bin/sh -s "\$0"</string>
    <string>$repo</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$node_bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$logs/launchd.log</string>
</dict>
</plist>
EOF
plutil -lint "$plist" > /dev/null
launchctl bootstrap "$domain" "$plist"
echo "installed $label: every night at 02:00, results in $logs"
