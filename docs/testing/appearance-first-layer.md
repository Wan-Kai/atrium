# Appearance first-layer experiment: preparation evidence

Status: **stopped after the baseline's one authorized offline installation failed; validation window released**. Baseline installation: one attempt, exit 1. Current installation, builds, selection-list commands and all four experiment cells: zero attempts. No diagnostic config/test/helper was created. Parent approved the installation-only process network restriction; its IPv4/IPv6 denial probe passed before the failed installation. No Electron app was launched and no raw heaps/traces/screenshots were produced. Parent task `t-f4e20102-1660-4a27-befc-804f02abf215` authorizes four single executions, not a fix or second-layer production instrumentation. This document records the stopped preparation, not an appearance test result. Formalized under parent task `t-edc23184-ac71-4cb7-a218-8e15f987c271`; no additional installation or network budget was granted.

| Activity | Executions | Outcome |
| --- | ---: | --- |
| Baseline offline frozen installation | 1 | Failed, exit 1; original evidence retained |
| Current installation | 0 | Not attempted |
| Builds, either version | 0 | Not attempted; no build hashes exist for this experiment |
| Playwright selection list | 0 | Not attempted |
| Baseline A / B, current A / B | 0 each | No product-test result |

The dependency blocker remains. The parent will decide appearance preparation separately while prioritizing the independently established children test-criterion issue; this document makes no new claim about that issue.

## Frozen inputs and preflight

- Current worktree: `ios-connect`, branch `agent/ios-connect`. Confirmed clean at `317b02e05c2692c295efb8c43c5900cfc64b02b8`; ancestor check succeeded and ff-only update to `c710d51da12b2bc4a1b21e31a3fab6e4255e7a8a` succeeded (no reset). Git post-merge/post-checkout hooks are absent. Update log: `/tmp/atrium-appearance-ff.log`.
- At the initial preflight, baseline `ace843a`, branch `agent/appearance-baseline-ace843a` and sibling worktree `appearance-baseline-ace843a` were proposed and both names were absent. The branch/worktree were subsequently created and are retained until acceptance; their installation outcome is recorded below.
- Existing dependency metadata `node_modules/.modules.yaml`: pnpm 12.9.1, store `/Users/ktoon/Library/pnpm/store/v11`.
- **Dependency decision obtained before builds:** parent approved one same-constraint offline/frozen synchronization for current as well as baseline. After ff, current tree lacks `packages/ui/node_modules/uqr` and `apps/desktop/node_modules/@atrium/protocol`. The fixed lock adds these workspace/importer links. Do not attempt a knowingly invalid build or silently reuse another worktree's artifacts. Parent explicitly authorized each installation separately, with before/after lock hashes and failure stopping the exercise. At that preparation checkpoint, the baseline worktree/branch had been created at `ace843a` and no build or installation had run. This is historical preflight status, superseded by the single failed baseline installation below.

## File and artifact inventory

The sole repository change is `docs/testing/appearance-first-layer.md`, promoted from the task draft. No diagnostic test was added to default collection.

- Proposed but **not created**: `apps/desktop/diagnostics/appearance-first-layer/playwright.config.ts`, `case.ts`, and any snapshot analysis helper.
- Created privately: `install-network.sb`, `install-network-probe.mjs`, `install-run.py`, `install-baseline.json`, empty user/global package-manager config files, probe results and the baseline installation log.
- **Not created**: `install-current.json`, product execution manifests or build/heap/trace evidence. Current installation and all product executions were never attempted.
- No system firewall/global configuration changes.

No edits to launch/heap helpers, production modules, lockfiles, ordinary tests, or log allowances. Experiment manifests, private temporary homes, raw snapshots and restricted summaries use the task-owned root `/tmp/atrium-appearance-first-layer.Nw52d0`, created with umask 077; root mode is 0700. The proposed diagnostic implementation was never created. No merge to main, push or worktree deletion occurred; private failure evidence remains in place.

## Planned product-test environment (not executed)

Pin Node at `/Users/ktoon/.nvm/versions/node/v22.19.0/bin/node`; PATH order: that directory, `/Users/ktoon/.local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`. The original pi symlink/package remains discoverable. Pin `LANG=en_US.UTF-8`, `LC_ALL=en_US.UTF-8`, `SHELL=/usr/bin/false`, `PI_OFFLINE=1` and `PLAYWRIGHT_BROWSERS_PATH=/Users/ktoon/Library/Caches/ms-playwright`. Use a minimal allowlisted environment without API keys, proxy, NODE_OPTIONS, SSH agent, or development overrides. Use the same explicit HOME/pi-dir/TMPDIR paths in all four cells, with owned private state reset between cells; record globalSetup's generated temporary-root differences separately. No outer sandbox and no Electron security relaxation; this is not a guarantee of zero external network traffic.

Run Playwright through the pinned Node and each revision's installed CLI to avoid implicit pnpm-run PATH variation. Default 60-second test budget, one worker, no retries or added timeout. Preserve the original `trace: retain-on-failure` and `screenshot: only-on-failure`; do not inspect/export raw trace frames/headers. Keep retained artifacts in a private test-owned directory and record only their existence/type. The original global setup remains responsible for its test temporary directories.

## Planned matrix and invariant checks (not executed)

Order: baseline A, baseline B, current A, current B. Each version gets at most one matching build. Explicit `--list` may verify selection; no anchoring assumption about full Playwright titles. Each cell is executed once only.

- A: original light baseline, 15 dark/light pairs, final heap and zero-growth check, then original close timing. Immediately before calling quit, record only the test-side timestamp; no new pre-close asynchronous IO or waiting.
- B: identical scenario, with a passive completion barrier immediately before quit for the already issued startup `check_setup` and `list_models`. Read existing completion spans only. Record `command.error`; span status alone is insufficient. No opening menus/settings and no additional RPC. Absence/unidentifiability of requests is a gap, not a fabricated completed state. Failed requests are not proof that every parallel internal worker has drained.
- Use test-owned `existingHome`, `markSetupDone`, `quit()` to preserve the final log, then `cleanup()` to retain the existing log gate. `existingHome` alone does NOT preserve logs when `close()` is called. Analyze before cleanup and precisely remove only owned paths in finally.
- Collect fixed categories, PID/trace/span, command, start/duration, code/signal/requested and enumerated reason only. No raw stderr, free errors, request/response bodies, headers, full attributes/events or user paths. Existing `pi exited` means adapter completion/close, not the raw OS exit event. Do not synthesize stdin/exit timings that are not logged.
- Protect directories/files as 0700/0600. Hash raw heaps and record necessary detached counts; if nonzero, retain only metadata-safe retention-path evidence before removing raw snapshots. Never dump snapshot strings. Preserve the original zero-growth and log-gate semantics.

## Recorded preparation outcome

- Baseline commit: `ace843a5942db64ac638cb0d91b9650dfd3baca7`; tree `7241bfb861e22eb498e39e124f627db0779b9b29`.
- Installation profile SHA-256: `ad9d4fdb76db3a41beb3fd5ad6557ef57e1b051663850048e51357ed46812edf`.
- Minimal pinned-Node probe: `192.0.2.1` and `2001:db8::1` both returned `EPERM`, probe exit 0. This demonstrates those direct IP attempts were refused, not every possible broker/XPC route.
- `pnpm store path --store-dir /Users/ktoon/Library/pnpm/store/v11` confirmed that exact store, not a nested version directory. Pinned Node reported `v22.19.0`.
- Baseline command: `sandbox-exec -f <private-root>/install-network.sb /Users/ktoon/.nvm/versions/node/v22.19.0/bin/pnpm install --offline --frozen-lockfile --store-dir /Users/ktoon/Library/pnpm/store/v11` with the manifest's allowlisted environment.
- Baseline installation exited 1 after about 0.24 seconds: `ERR_PNPM_META_FETCH_FAIL` / `ERR_PNPM_NO_OFFLINE_META`. The actual missing metadata file is `<temporary HOME>/Library/Caches/pnpm/v11/metadata-full/https%3A+registry.npmjs.org/@babel/helper-module-transforms.jsonl` (parent verified the original output; the first summary's basename extractor truncated the `.jsonl` suffix). The captured installation output contains no postinstall stage mention; do not describe this as an Electron cache failure or product-test failure.
- Baseline lock SHA-256 before and after: `164c83a672286b0e9f2e9ceeae0c38179eeced11c799b37637b8fbb84e0723fe` (unchanged).
- `install-baseline.json` records command, explicit environment, source/tree/lock/profile hashes, start/end and exit. `install-baseline.log` retains the original failure privately; only error codes and the metadata basename were exposed in the report.
- Root permission checked 0700, install log/manifest checked 0600. No install driver remains running. No online fallback, retries, skipped scripts, build reuse, product launch or raw snapshot collection occurred.
- Both branches/worktrees are retained, including the newly created `appearance-baseline-ace843a` worktree on `agent/appearance-baseline-ace843a`. At the preparation stop, baseline tracked files were clean and current had only the untracked task draft; this document is its subsequent formalization. Task-private scripts and installation files remain in the private root. No product cleanup was required because no app started; do not treat any partially prepared dependency state as a successful installation.

Resumption requires a new parent decision on satisfying offline registry metadata and explicitly authorizing any further installation attempt; the baseline's permitted attempt has been consumed. Do not retry it under the old authorization.

## Read-only cache investigation (parent task t-c5b87a5d-e7cd-4c37-af62-7ae7f7f3bd96)

During that read-only investigation, no new installation, CLI/config probe, network probe, build or test was performed. Only the task draft was edited; package-cache inspection and in-memory hashing/parsing did not rewrite caches. No user npmrc, credentials or unrelated project records were output.

### Cache-location configuration: evidence limit

The installed pnpm 12.9.1 package contains a native Mach-O CLI, launchers and a changelog, but no Rust configuration implementation was found in that installation. Its native binary contains the recognized-setting spellings `cacheDir` / `cache-dir`, `XDG_CACHE_HOME`, and the `PNPM_CONFIG_` prefix. These are static leads, not proof that `install --cache-dir` is accepted or that a particular environment variable wins on macOS. The shipped changelog at line 2519 explicitly documents `pnpm cache path` as the way to print the metadata-cache directory, including its verification log. No such CLI query was executed under this read-only/no-new-probe task. Consequently this investigation does not claim a validated cache override syntax; a future explicitly permitted read-only configuration query or matching native source is still needed for that part.

### Subsequent parent CLI observations

The parent reported the following additional read-only commands in the same empty-configuration, network-restricted environment. These were not rerun by this agent:

- CLI help lists `pnpm cache` subcommands `list`, `list-registries`, `path`, `view`, `delete` and `prune`; there is no `add`. `pnpm cache add --help` exited 2.
- `pnpm cache path` reported that temporary HOME's `Library/Caches/pnpm`. This confirms the default cache location in that environment, not an override syntax or cache completeness.
- `pnpm view --help` exposes a registry-query command. The parent did **not** execute an online `view`, and no evidence establishes that it would populate the required full metadata cache. It is not a demonstrated cache-repair procedure.

No execution-input hashes or additional exit codes were supplied for those parent commands; none are invented here. The earlier offline installation failure and the absence of a verified compatible full-metadata/verification cache remain unchanged.

### The requested public package is present, but not as full metadata

Scoped filename inspection of the pnpm cache found the official npm package at:

- `v11/metadata/https%3A+registry.npmjs.org/@babel/helper-module-transforms.jsonl`: modern `pacquet-meta-v1 87 3776` indexed-JSON format, not an ordinary JSONL file or gzip archive. Its index locates version `8.0.6`; that record's `dist.integrity` matches both frozen lockfiles. It has no publish-time field; the package index has no `time` map. File SHA-256: `454e8301403397bc21f1875c0c416214805e49ad6f2956dc6f5521c87e06e32a`.
- `v11/metadata/registry.npmjs.org/@babel/helper-module-transforms.jsonl`: older header-plus-package-JSON layout. Its versions do not contain `8.0.6`, and it has no `time` map.

No same-package file was found under the official registry's full-metadata layouts, including `v11`, `v12`, or the older full metadata cache tree. A corporate-registry filename was observed but its contents were not read or substituted. The installed changelog at lines 284, 2356 and 2762 describes old-layout incompatibility, the need for full publish-time metadata under release-age policy, and offline verification failing when required metadata is absent. Therefore changing the cache root alone is not demonstrated to supply the missing full metadata. Do not rename abbreviated/old metadata into `metadata-full`, fabricate dates, change registry identity, or convert formats by hand.

### Existing verification log is not a proven match

`lockfile-verified.jsonl` is a normal verification cache, not a list of unconditional approvals. Its records carry a lockfile fingerprint (`hash`, `path`, `size`, `mtimeNs`, `inode`) and policy. Filtering locally without displaying unrelated records found:

- No record for the newly created baseline lockfile path.
- Two records for the current `ios-connect` path, both with stale size, inode and mtime relative to `c710d51`.
- Thirteen Atrium records with the baseline lockfile's byte size, sharing one hash and policy. Same size does not prove the same lockfile. The cache hash did not match the file's raw SHA-256 or BLAKE3; the native fingerprint algorithm was not established, so those negative comparisons must not be treated as proof that content-based reuse is impossible.
- The historical candidate policies include `minimumReleaseAgeIgnoreMissingTime: true`, along with registry-routing and other binding fields. Their compatibility with the current isolated policy is not established. Do not copy that allowance into the experiment or manufacture a cache entry to obtain a hit.

A safe future candidate, not an approved or proven installation recipe, is to expose a byte-identical snapshot of the relevant existing normal cache through a natively supported cache-root setting, leaving the original cache unchanged and allowing pnpm to validate fingerprints and policy itself. Cache-root support and a matching native verification fingerprint/policy remain unproved; the missing full metadata remains a concrete fallback blocker. Do not spend another install attempt merely assuming this candidate will work. Any further attempt requires new parent authorization; the original failed attempt remains evidence.

## Evidence and stopping rules

Before executions, record commit/tree/diagnostic hashes, lockfile and relevant build-artifact hashes, explicit environment, installed-tool identity and exact commands. Per cell preserve manifest, exit code, sanitized observation summary and cleanup outcome. Failures remain evidence. Compilation, dependency, launch or diagnostic-fixture errors stop the exercise; do not calibrate or retry. Warning/DOM failures are observations, not reasons to weaken checks.

Offline dependency preparation, if needed and authorized, must use the existing explicit store, fresh HOME/empty package-manager config, frozen lockfile and retained supply-chain/lifecycle checks. Preflight found root postinstall invokes `install-electron`; Electron 44.5.1 `install.js` invokes `@electron/get` when its installed dist is missing, without checking pnpm/npm offline flags. `--offline` therefore does not itself enforce offline lifecycle behavior. The initial parent question timed out; subsequent explicit authorization permits an installation-only network restriction, leaving all four Electron experiments unsandboxed. Probe its actual IP denial before use; record the profile hash and result. This does not claim to block every broker/XPC network path. Parent also permits the existing official Electron download cache via the installer's supported `electron_config_cache` parameter, retaining its normal integrity check. Cache discovered at `/Users/ktoon/Library/Caches/electron`, containing the pinned darwin-arm64 44.5.1 archive; no other worktree's build output is used. Review lifecycle behavior before invoking; never silently download, skip scripts, mutate lockfile or switch online. A failure stops preparation.

All-green means only this matrix did not reproduce the historical failure. No claim that the old appearance warning is fixed, that faux proves real-pi shutdown, or that the unrelated 67/68 non-leak run covers appearance. Release the exclusive validation window explicitly when stopped or complete.
