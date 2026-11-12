#!/bin/sh
# Installs, or with `uninstall` removes, the launchd job that keeps the iPhone's Atrium signed and on
# main's latest commit, on weekday mornings and evenings (development.md, "自动续签"). The job runs
# main's own copy of ios-sign.mjs, whatever branch this checkout is on, and only works when the phone
# is on the same Wi-Fi as this Mac. A Mac asleep at the hour runs it when it wakes. The Node that runs
# this script is the one the job uses.
set -eu

label="com.atrium.ios-sign"
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
logs="$HOME/Library/Logs/Atrium/ios-sign"
mkdir -p "$logs" "$(dirname "$plist")"

# Monday (2) to Friday (6) at 11:00 and 19:00, launchd counting Sunday as 1.
slots=""
for weekday in 2 3 4 5 6; do
  for hour in 11 19; do
    slots="$slots  <dict><key>Weekday</key><integer>$weekday</integer><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>0</integer></dict>
"
  done
done

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
    <string>d=\$(mktemp -d) || exit 1; trap 'rm -rf "\$d"' EXIT; git -C "\$1" show main:scripts/ios-sign.mjs &gt; "\$d/ios-sign.mjs" || exit 1; node "\$d/ios-sign.mjs" "\$1"</string>
    <string>sh</string>
    <string>$repo</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$node_bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
$slots  </array>
  <key>StandardOutPath</key><string>$logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$logs/launchd.log</string>
</dict>
</plist>
EOF
plutil -lint "$plist" > /dev/null
launchctl bootstrap "$domain" "$plist"
echo "installed $label: weekdays at 11:00 and 19:00, results in $logs/launchd.log"
