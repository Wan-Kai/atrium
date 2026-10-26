#!/bin/sh
# Downloads cacophony's Noise test vectors, checks the pinned SHA-256 and writes the IK and
# IKpsk2 25519/ChaChaPoly/SHA256 vectors to the test resources.
# Usage: tools/extract-vectors.sh   (from spikes/mobile-mp0/swift), then `pnpm exec oxfmt <out>` from the
# repository root so the committed file passes `pnpm format:check`.
set -eu

url="https://raw.githubusercontent.com/haskell-cryptography/cacophony/master/vectors/cacophony.txt"
sha256="3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae"
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/Tests/AtriumNoiseSpikeTests/Resources/cacophony-ik.json"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/cacophony.txt" "$url"
actual=$(shasum -a 256 "$work/cacophony.txt" | cut -d' ' -f1)
if [ "$actual" != "$sha256" ]; then
  echo "cacophony.txt SHA-256 is $actual, expected $sha256" >&2
  exit 1
fi

python3 -I - "$work/cacophony.txt" "$out" "$sha256" <<'PY'
import json, sys
source, out, sha = sys.argv[1], sys.argv[2], sys.argv[3]
wanted = ["Noise_IK_25519_ChaChaPoly_SHA256", "Noise_IKpsk2_25519_ChaChaPoly_SHA256"]
vectors = [v for v in json.load(open(source))["vectors"] if v["protocol_name"] in wanted]
assert sorted(v["protocol_name"] for v in vectors) == sorted(wanted), "expected exactly one vector per protocol"
with open(out, "w") as f:
    json.dump({"source": "cacophony/vectors/cacophony.txt", "sha256": sha, "vectors": vectors}, f, indent=2)
    f.write("\n")
PY
echo "wrote $out"
