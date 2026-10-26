# Local relay ↔ TS hosts ↔ production Swift

From the repository root (existing pnpm dependencies and Xcode Swift toolchain required):

```sh
node apps/ios/Integration/run.mjs
```

The default command runs only `LocalRelayInteropTests`. It uses the production `apps/relay/src/relay.ts`, the unchanged
MP0 `FakeHost`, and the current `AtriumRemote` / `AtriumNoise` implementations. This is an MP4
connection-layer check against SPEC-0005 “配对流程”, “日常连接”, “撤销” and “Noise 通道”; it is **not**
the future full production-host/faux-pi contract suite.

The test checks:

- IKpsk2 pairing, matching six-digit SAS on both implementations, explicit host confirmation;
- pending → confirmed `HostStore` records in an isolated `MemorySecretStore`;
- `hello` / `welcome` on the pairing channel;
- closing that channel, loading the stored identity, and a fresh IK connection with the same device id;
- `hello` / `welcome` and an encrypted heartbeat acknowledgement on the new channel;
- authenticated `revoked`, channel closure, and `device_unknown` on a new IK attempt with the old key.

MP0 is frozen at protocol **25**. The test explicitly supplies 25 to the production Swift handshake
and hello APIs; it does not lower the application's default protocol version.

## Isolation and cleanup

Both the real relay and the test-only HTTP control endpoint bind **127.0.0.1, port 0**. The relay
uses `/atrium` to exercise path-prefix preservation. All host keys/device records live in memory;
Swift uses an in-memory secret store, never the user's keychain. A random bearer token protects the
control endpoint. No deployed relay, user server, user credential, persistent host state or app is used.

The runner resolves the already-installed esbuild through Vite, bundles into an OS temporary
directory, and explicitly defines `import.meta.main=false`: otherwise bundling MP0's CLI guard into
an entry module could start its interactive CLI. It adds no dependency and changes no spike file.

The runner bounds the Swift process to five minutes, terminates its owned process group on timeout
or SIGINT/SIGTERM (SIGKILL fallback), closes host/relay/control sockets, checks relay resource counts
return to zero, and removes its temporary bundle. Swift closes every transport/channel on error.
Ordinary `swift test` skips this opt-in test when the runner's environment is absent.

## Sensitivity check

```sh
node apps/ios/Integration/run.mjs --negative-control
```

This deliberately reports an incorrect host SAS over the test control endpoint. The Swift SAS
assertion must fail and the command must exit nonzero. It does not mutate production code. Run the
normal command again afterwards to verify the green path and cleanup.

## Rejection reason boundary

The production `RemoteService` maps its local pairing projection reason `declined` to the encrypted
`pair_rejected.reason = "rejected"` sent to a phone. MP0 `FakeHost.confirmPairing(false)` also sends
`rejected`. These are different boundaries, not competing spellings of the local view state. Swift
must display that wire refusal as `.declined` (Mac declined), retain the existing `declined` behavior,
and keep genuinely unknown reasons as `.other`. This mapping does not change authorization or the
existing scoped cleanup: remove this pending attempt while retaining the old confirmed host.

The focused Swift Noise/presentation regressions cover this mapping. The current runner exercises
successful confirmation only; they are **not** evidence of a production RemoteService → relay → Swift
rejection exchange. Use the separate production-service mode below for that boundary.

## Production rejection check

```sh
node apps/ios/Integration/run.mjs --production-rejection
```

This dedicated mode leaves the frozen MP0 test intact. It exercises SPEC-0005's pairing refusal
at the service boundary, using the generated current Swift protocol version (27 at introduction).
Its contract is:

1. Reuse the existing real loopback relay, `/atrium` prefix, random credentials, authenticated control
   endpoint and owned-process cleanup. Construct **production RemoteService**, not FakeHost. Supply
   only its storage/index ports in memory, the production injected clock/logger and a separate host
   resource tracker. Derive the relay registration line from this relay's actual address and token.
2. Do not import `packages/host/test/remote/service-fixture.ts` into the Node bundle: it depends on
   Vitest. Reproduce only its small version-fenced VaultPort and index-port setup, without write gates,
   FakePhone, Vitest hooks or a generic fixture framework. Bundle the actual RemoteService source.
3. Enable the service, wait for connected, call `startPairing()` and obtain the QR from the local-only
   `get()` view. Swift uses its normal generated protocol version (no MP0 version-25 override).
4. After Swift's real Noise flow reports SAS, the control route waits for the service's
   `awaiting_confirmation` view, checks the SAS and calls `confirmPairing(pairingId, false)`. It never
   writes a rejection frame or substitutes HTTP data for the encrypted result. Assert Swift receives
   `.failed(.declined)`, no channel and no pending record; TS observes local reason `declined`, no
   accepted application transport and an unchanged device list. Removing Swift's `rejected` mapping
   must make this dynamic regression fail.
5. Always close service, relay and control listeners and assert both resource trackers return to zero,
   including startup/Swift/assertion failures and interruption.

This covers **RemoteService + production relay → production Swift**, including the onEnded wire
mapping. It does not start `startHost`, Electron persistence, the application router or faux-pi, and
is not full MP4 synchronization or a production-host startup contract. The Swift test seeds an old
local host record solely to check retention; it does not claim a previous server-side pairing.

### Test-only entry points

| Entry                                                         | Scope                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--production-rejection`                                      | Selects the production fixture and `ProductionRejectionInteropTests`; cannot combine with MP0's `--negative-control`.                                                                 |
| `--hold-confirmation`                                         | Only with production mode: after a real matching SAS/awaiting-confirmation, hold the reject HTTP request for the SIGTERM cleanup check. Bounded to five seconds; never grants access. |
| `ATRIUM_LOCAL_INTEROP_CONTROL` / `ATRIUM_LOCAL_INTEROP_TOKEN` | Existing ephemeral loopback origin/bearer, injected only into the owned Swift test child.                                                                                             |
| `ATRIUM_LOCAL_INTEROP_SCENARIO`                               | Runner-set `mp0` or `production-rejection`; selects opt-in Swift tests, never read by App/production code.                                                                            |

Both modes compile Swift with `--jobs 1`. To prove sensitivity, temporarily remove only the Swift
`rejected` alias, run production mode (must fail the Mac-refusal assertion), restore the alias and
rerun. For interruption, run production mode with `--hold-confirmation`, wait for its held-rejection
beacon, then SIGTERM the runner; expect nonzero exit, zero host/relay counters, closed control
requests/listeners, no surviving owned Swift group and removal of the temporary bundle directory.
Actual results belong in the coverage map, not inferred from this recipe.

Not covered: complete production host/startHost, UI/scanning, real keychain persistence,
automatic reconnect/backoff or heartbeat scheduling, background/foreground transitions, physical
iPhone, TLS, WAN failure injection, full repository checks or mutation testing.
