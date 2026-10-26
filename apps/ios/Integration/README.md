# Local relay ↔ TS MP0 host ↔ production Swift

From the repository root (existing pnpm dependencies and Xcode Swift toolchain required):

```sh
node apps/ios/Integration/run.mjs
```

Only `LocalRelayInteropTests` runs. It uses the production `apps/relay/src/relay.ts`, the unchanged
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
rejection exchange. That dynamic production-service test remains a separate, pending integration step.

## Proposed production rejection check (not implemented)

Add one opt-in fixture/suite selected by `run.mjs`, leaving the frozen MP0 test intact:

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

This would cover **RemoteService + production relay → production Swift**, including the onEnded wire
mapping. It would not start `startHost`, Electron persistence, the application router or faux-pi, and
would not count as full MP4 synchronization or a production-host startup contract. No such new fixture
or dynamic run is part of the current narrow mapping fix.

Not covered: production TS host, protocol 26 semantics, UI/scanning, real keychain persistence,
automatic reconnect/backoff or heartbeat scheduling, background/foreground transitions, physical
iPhone, TLS, WAN failure injection, full repository checks or mutation testing.
