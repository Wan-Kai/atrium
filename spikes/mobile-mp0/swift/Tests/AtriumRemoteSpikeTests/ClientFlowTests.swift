import AtriumNoiseSpike
import CryptoKit
import Foundation
import Synchronization
import Testing

@testable import AtriumRemoteSpike

/// The phone's flows against the in-process ``TestHost`` over ``MemorySocket``.
@Suite("client flows")
struct ClientFlowTests {
    let info = DeviceInfo(deviceName: "Test iPhone", model: "iPhone18,1", appVersion: "0.0.1")

    @Test func pairingShowsTheSameCodeAndContinuesWithHello() async throws {
        let host = TestHost()
        let (phoneSocket, hostSocket) = MemorySocket.pair()
        let deviceKey = Curve25519.KeyAgreement.PrivateKey()
        let served = Task { try await host.serve(hostSocket) }
        let shown = Mutex2<String?>(nil)

        let result = try await RemoteClient.pair(
            link: host.link, deviceKey: deviceKey, info: info, socket: phoneSocket,
            onCode: { code in shown.set(code) })
        #expect(result.deviceId == host.deviceId)
        #expect(result.hostName == host.hostName)
        let welcome = try await RemoteClient.hello(channel: result.channel, deviceId: result.deviceId)
        #expect(welcome.type == "welcome")
        try await result.channel.sendHeartbeat()
        #expect(try await result.channel.nextEvent() == .heartbeatAck)

        let seen = try await served.value
        #expect(seen.mode == .ikpsk2)
        #expect(seen.code == result.code)
        #expect(shown.get() == result.code)
        #expect(seen.deviceKey == deviceKey.publicKey.rawRepresentation)
        let request = try RemoteJSON.decode(PairRequest.self, from: seen.request)
        #expect(request == PairRequest(
            pairingId: host.pairingId, deviceName: "Test iPhone", model: "iPhone18,1", appVersion: "0.0.1",
            protocolVersion: atriumProtocolVersion))
        #expect(seen.hello?.clientId == host.deviceId)
        #expect(seen.hello?.traceparent.count == 55)
        // No token on a remote hello (SPEC-0005 "协议改动" 1).
        let helloFrame = try #require(seen.hello)
        #expect(!String(decoding: RemoteJSON.encode(helloFrame), as: UTF8.self).contains("token"))
        // The phone's first frame carries the Atrium header for IKpsk2.
        #expect(phoneSocket.sent.withLock { Array($0[0].prefix(3)) } == [0x41, 0x01, 0x02])
    }

    @Test func dailyConnectionUsesIK() async throws {
        let host = TestHost()
        let (phoneSocket, hostSocket) = MemorySocket.pair()
        let deviceKey = Curve25519.KeyAgreement.PrivateKey()
        let served = Task { try await host.serve(hostSocket) }
        let result = try await RemoteClient.connect(
            hostId: host.hostId, hostKey: host.hostKey.publicKey.rawRepresentation, deviceKey: deviceKey,
            appVersion: "0.0.1", socket: phoneSocket)
        #expect(result.deviceId == host.deviceId)
        _ = try await RemoteClient.hello(channel: result.channel, deviceId: result.deviceId)
        try await result.channel.sendHeartbeat()
        #expect(try await result.channel.nextEvent() == .heartbeatAck)
        let seen = try await served.value
        #expect(seen.mode == .ik)
        #expect(try RemoteJSON.decode(ConnectRequest.self, from: seen.request).kind == "connect")
        #expect(phoneSocket.sent.withLock { Array($0[0].prefix(3)) } == [0x41, 0x01, 0x01])
    }

    @Test func handshakeRefusalIsReportedAndCloses() async throws {
        let host = TestHost()
        let (phoneSocket, hostSocket) = MemorySocket.pair()
        let served = Task { try await host.serve(hostSocket, behaviour: .refuseHandshake(reason: "device_unknown")) }
        await #expect(throws: RemoteError.rejected(reason: "device_unknown")) {
            _ = try await RemoteClient.connect(
                hostId: host.hostId, hostKey: host.hostKey.publicKey.rawRepresentation,
                deviceKey: Curve25519.KeyAgreement.PrivateKey(), appVersion: "0.0.1", socket: phoneSocket)
        }
        _ = try await served.value
        #expect(phoneSocket.isClosed)
    }

    @Test func pairRejectedAfterKeyConfirmation() async throws {
        let host = TestHost()
        let (phoneSocket, hostSocket) = MemorySocket.pair()
        let served = Task { try await host.serve(hostSocket, behaviour: .rejectPairing(reason: "pairing_busy")) }
        await #expect(throws: RemoteError.rejected(reason: "pairing_busy")) {
            _ = try await RemoteClient.pair(
                link: host.link, deviceKey: Curve25519.KeyAgreement.PrivateKey(), info: info, socket: phoneSocket,
                onCode: { _ in })
        }
        _ = try await served.value
    }

    @Test func wrongHostKeyFailsTheHandshake() async throws {
        let host = TestHost()
        let (phoneSocket, hostSocket) = MemorySocket.pair()
        let served = Task { try await host.serve(hostSocket) }
        await #expect(throws: RemoteError.self) {
            _ = try await RemoteClient.connect(
                hostId: host.hostId, hostKey: Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation,
                deviceKey: Curve25519.KeyAgreement.PrivateKey(), appVersion: "0.0.1", socket: phoneSocket)
        }
        await #expect(throws: NoiseError.decryptFailed) { _ = try await served.value }
    }

    /// Runs a handshake by hand and returns the phone's channel and the host's raw transport.
    func openChannel(chunkTimeout: Duration = .seconds(30)) throws -> (SecureChannel, NoiseTransport, MemorySocket) {
        let hostKey = Curve25519.KeyAgreement.PrivateKey()
        let phone = try NoiseHandshake(
            pattern: .ik, role: .initiator, prologue: Data(), localStatic: .init(),
            remoteStatic: hostKey.publicKey.rawRepresentation)
        let host = try NoiseHandshake(pattern: .ik, role: .responder, prologue: Data(), localStatic: hostKey)
        _ = try host.readMessage(try phone.writeMessage(payload: Data()))
        _ = try phone.readMessage(try host.writeMessage(payload: Data()))
        let phoneResult = try phone.split()
        let hostResult = try host.split()
        let (phoneSocket, hostSocket) = MemorySocket.pair()
        let channel = SecureChannel(
            socket: phoneSocket, transport: phoneResult.transport, handshakeHash: phoneResult.handshakeHash,
            chunkTimeout: chunkTimeout)
        return (channel, hostResult.transport, hostSocket)
    }

    @Test func incompleteChunkClosesTheChannelAfterTheTimeout() async throws {
        let (channel, host, hostSocket) = try openChannel(chunkTimeout: .milliseconds(200))
        try await hostSocket.send(try host.encrypt(ChannelFrame.chunk(Data("part".utf8), isLast: false).encoded()))
        let start = ContinuousClock.now
        await #expect(throws: RemoteError.chunkTimeout) { _ = try await channel.nextEvent() }
        #expect(ContinuousClock.now - start >= .milliseconds(200))
        #expect(hostSocket.isClosed)
    }

    @Test func largeMessagesArriveWholeAndHeartbeatsAreAnswered() async throws {
        let (channel, host, hostSocket) = try openChannel()
        let big = Data((0..<200_000).map { UInt8(0x61 + ($0 * 7) % 26) })
        try await hostSocket.send(try host.encrypt(ChannelFrame.heartbeat.encoded()))
        for frame in try ChannelFrame.chunks(of: big, limit: ChannelLimits.hostToPhone) {
            try await hostSocket.send(try host.encrypt(frame.encoded()))
        }
        #expect(try await channel.nextEvent() == .heartbeat)
        #expect(try await channel.nextEvent() == .message(big))
        #expect(try ChannelFrame.decode(host.decrypt(try await hostSocket.receive())) == .heartbeatAck)

        try await channel.sendMessage(big)
        var received = Data()
        while true {
            guard case .chunk(let body, let isLast) = try ChannelFrame.decode(host.decrypt(try await hostSocket.receive()))
            else { Issue.record("expected a chunk"); return }
            received += body
            if isLast { break }
        }
        #expect(received == big)
    }

    @Test func tamperedFrameClosesTheChannel() async throws {
        let (channel, host, hostSocket) = try openChannel()
        var frame = try host.encrypt(ChannelFrame.heartbeat.encoded())
        frame[0] ^= 1
        try await hostSocket.send(frame)
        await #expect(throws: RemoteError.noise(.decryptFailed)) { _ = try await channel.nextEvent() }
        #expect(hostSocket.isClosed)
        await #expect(throws: RemoteError.socketClosed) { try await channel.sendHeartbeat() }
    }

    @Test func unknownFrameTypeClosesTheChannel() async throws {
        let (channel, host, hostSocket) = try openChannel()
        try await hostSocket.send(try host.encrypt(Data([0x05])))
        await #expect(throws: RemoteError.unknownFrameType(0x05)) { _ = try await channel.nextEvent() }
        #expect(hostSocket.isClosed)
    }

    @Test func oversizedOutgoingMessageIsRefused() async throws {
        let (channel, _, _) = try openChannel()
        await #expect(throws: RemoteError.messageTooLarge(limit: ChannelLimits.phoneToHost)) {
            try await channel.sendMessage(Data(count: ChannelLimits.phoneToHost + 1))
        }
    }
}

/// A tiny lock box for values set from `@Sendable` closures in tests.
final class Mutex2<Value: Sendable>: Sendable {
    private let lock: Mutex<Value>
    init(_ value: Value) { lock = Mutex(value) }
    func set(_ value: Value) { lock.withLock { $0 = value } }
    func get() -> Value { lock.withLock { $0 } }
}
