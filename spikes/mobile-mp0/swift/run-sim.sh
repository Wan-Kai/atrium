#!/bin/sh
# Builds the MP0 test app, installs it on an iOS 26.5 simulator and launches it.
#
# Usage: ./run-sim.sh [pairing link] [--auto-pair] [--auto-connect] [--no-build]
#                    [--screenshot <file.png>] [--wait <seconds>]
#   pairing link   pre-fills the text field (launch argument -pairLink);
#   --auto-pair    starts pairing right away (-autoPair YES);
#   --auto-connect connects to the Mac saved in the keychain with IK (-autoConnect YES);
#   --no-build     reinstalls nothing, only relaunches the installed app;
#   --screenshot   waits (--wait, default 3 s), then saves a screenshot of the simulator.
# The simulator shares the Mac's network, so ws://127.0.0.1:<port> reaches a relay on this Mac.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
name="Atrium Spike (iPhone 17 Pro)"
runtime="com.apple.CoreSimulator.SimRuntime.iOS-26-5"
device_type="com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
bundle_id="site.ktoon.atrium.spike"
derived="$here/build"

link=""
auto_pair="NO"
auto_connect="NO"
build="YES"
screenshot=""
wait_seconds=3
while [ $# -gt 0 ]; do
  case "$1" in
    --auto-pair) auto_pair="YES" ;;
    --auto-connect) auto_connect="YES" ;;
    --no-build) build="NO" ;;
    --screenshot) screenshot="$2"; shift ;;
    --wait) wait_seconds="$2"; shift ;;
    *) link="$1" ;;
  esac
  shift
done

udid=$(xcrun simctl list devices -j | python3 -I -c '
import json, sys
name, runtime = sys.argv[1], sys.argv[2]
for device in json.load(sys.stdin)["devices"].get(runtime, []):
    if device["name"] == name and device["isAvailable"]:
        print(device["udid"]); break
' "$name" "$runtime")
if [ -z "$udid" ]; then
  udid=$(xcrun simctl create "$name" "$device_type" "$runtime")
  echo "created simulator $udid"
fi
xcrun simctl bootstatus "$udid" -b >/dev/null
open -a Simulator --args -CurrentDeviceUDID "$udid"

xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true
if [ "$build" = "YES" ]; then
  xcodebuild -quiet \
    -project "$here/SpikeApp/AtriumSpike.xcodeproj" \
    -scheme AtriumSpike \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=$udid,arch=arm64" \
    -derivedDataPath "$derived" \
    build
  # Installing over the old copy keeps its keychain items (same bundle id and team).
  xcrun simctl install "$udid" "$derived/Build/Products/Debug-iphonesimulator/AtriumSpike.app"
fi
xcrun simctl launch "$udid" "$bundle_id" -pairLink "$link" -autoPair "$auto_pair" -autoConnect "$auto_connect"

if [ -n "$screenshot" ]; then
  sleep "$wait_seconds"
  xcrun simctl io "$udid" screenshot "$screenshot"
fi
echo "simulator $udid"
