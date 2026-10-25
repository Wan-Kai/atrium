import AtriumNoiseSpike
import CryptoKit
import Foundation

/// What the phone reports about itself in the pairing request.
public struct DeviceInfo: Sendable {
    public var deviceName: String
    public var model: String
    public var appVersion: String

    /// Builds the description.
    ///
    /// - Side effects: none.
    public init(deviceName: String, model: String, appVersion: String) {
        self.deviceName = deviceName
        self.model = model
        self.appVersion = appVersion
    }
}

/// A pairing the Mac confirmed.
public struct PairingResult: Sendable {
    /// The id the host gave this phone; the `clientId` of `hello` from now on.
    public let deviceId: String
    /// The Mac's name.
    public let hostName: String
    /// The pairing code that was shown.
    public let code: String
    /// The channel, ready for `hello` (SPEC-0005 "配对流程" step 5).
    public let channel: SecureChannel
}

/// A daily connection the host accepted.
public struct ConnectResult: Sendable {
    /// The id the host knows this phone by.
    public let deviceId: String
    /// The channel, ready for `hello`.
    public let channel: SecureChannel
}

/// The phone's side of pairing, daily connection and the Atrium handshake (SPEC-0005).
public enum RemoteClient {
    /// Pairs with IKpsk2: handshake, key confirmation, pairing code, then waits for the Mac.
    ///
    /// - Parameters:
    ///   - link: The scanned pairing link.
    ///   - deviceKey: This phone's static key, already in the keychain.
    ///   - info: What to tell the Mac about this phone.
    ///   - socket: Connected to `<relay>/v1/client?host=<hostId>`.
    ///   - onCode: Called with the 6 digits once the key confirmation is queued.
    /// - Side effects: Sends and receives on `socket`; closes it on failure.
    /// - Returns: The confirmed pairing and its open channel.
    /// - Throws: ``RemoteError``; ``RemoteError/rejected(reason:)`` when the host refuses.
    public static func pair(
        link: PairingLink,
        deviceKey: Curve25519.KeyAgreement.PrivateKey,
        info: DeviceInfo,
        socket: any FrameSocket,
        onCode: @Sendable (String) async -> Void
    ) async throws(RemoteError) -> PairingResult {
        let request = PairRequest(
            pairingId: link.pairingId, deviceName: info.deviceName, model: info.model,
            appVersion: info.appVersion, protocolVersion: atriumProtocolVersion)
        let (reply, channel) = try await handshake(
            mode: .ikpsk2, hostId: link.hostId, hostKey: link.hostKey, psk: link.psk, deviceKey: deviceKey,
            payload: RemoteJSON.encode(request), socket: socket)
        guard reply.ok else {
            await channel.close()
            throw .rejected(reason: reply.reason ?? "unknown")
        }
        try await channel.sendControl(.pairConfirm)
        let code = PairingCode.digits(handshakeHash: channel.handshakeHash)
        await onCode(code)
        while true {
            switch try await channel.nextEvent() {
            case .heartbeat, .heartbeatAck: continue
            case .message:
                await channel.close()
                throw .unexpectedControl(kind: "message")
            case .control(let body):
                switch try RemoteJSON.decode(ControlMessage.self, from: body) {
                case .paired(let deviceId, let hostName):
                    return PairingResult(deviceId: deviceId, hostName: hostName, code: code, channel: channel)
                case .pairRejected(let reason):
                    await channel.close()
                    throw .rejected(reason: reason)
                case .revoked:
                    await channel.close()
                    throw .rejected(reason: "revoked")
                case .pairConfirm:
                    await channel.close()
                    throw .unexpectedControl(kind: "pair_confirm")
                }
            }
        }
    }

    /// Connects an already paired phone with IK.
    ///
    /// - Side effects: Sends and receives on `socket`; closes it on failure.
    /// - Returns: The device id and the open channel.
    /// - Throws: ``RemoteError``; ``RemoteError/rejected(reason:)`` with `device_unknown` or
    ///   `version_mismatch`, after which the phone stops reconnecting.
    public static func connect(
        hostId: String,
        hostKey: Data,
        deviceKey: Curve25519.KeyAgreement.PrivateKey,
        appVersion: String,
        socket: any FrameSocket
    ) async throws(RemoteError) -> ConnectResult {
        let request = ConnectRequest(appVersion: appVersion, protocolVersion: atriumProtocolVersion)
        let (reply, channel) = try await handshake(
            mode: .ik, hostId: hostId, hostKey: hostKey, psk: nil, deviceKey: deviceKey,
            payload: RemoteJSON.encode(request), socket: socket)
        guard reply.ok, let deviceId = reply.deviceId else {
            await channel.close()
            throw .rejected(reason: reply.reason ?? "unknown")
        }
        return ConnectResult(deviceId: deviceId, channel: channel)
    }

    /// Sends `hello` without a token, `clientId` = `deviceId`, and waits for `welcome`.
    ///
    /// - Side effects: Sends and receives on the channel; closes it on failure.
    /// - Returns: The host's `welcome`.
    /// - Throws: ``RemoteError``.
    public static func hello(channel: SecureChannel, deviceId: String) async throws(RemoteError) -> WelcomeMessage {
        let hello = HelloMessage(
            protocolVersion: atriumProtocolVersion, clientId: deviceId, traceparent: makeTraceparent())
        try await channel.sendMessage(RemoteJSON.encode(hello))
        while true {
            switch try await channel.nextEvent() {
            case .heartbeat, .heartbeatAck: continue
            case .control(let body):
                let control = try RemoteJSON.decode(ControlMessage.self, from: body)
                await channel.close()
                throw control == .revoked ? .rejected(reason: "revoked") : .unexpectedControl(kind: "\(control)")
            case .message(let body):
                let welcome = try RemoteJSON.decode(WelcomeMessage.self, from: body)
                guard welcome.type == "welcome" else {
                    await channel.close()
                    throw .badPayload
                }
                return welcome
            }
        }
    }

    /// Runs the two handshake messages as initiator and wraps the result in a channel.
    ///
    /// - Remarks: The reply's payload is authenticated by the host's static key, so a refusal in
    ///   it can be trusted (SPEC-0005 "配对流程" step 2); the channel is returned either way so the
    ///   caller closes it.
    /// - Side effects: Sends and receives on `socket`; closes it on failure.
    private static func handshake(
        mode: HandshakeMode,
        hostId: String,
        hostKey: Data,
        psk: Data?,
        deviceKey: Curve25519.KeyAgreement.PrivateKey,
        payload: Data,
        socket: any FrameSocket
    ) async throws(RemoteError) -> (HandshakeReply, SecureChannel) {
        do {
            let handshake = try NoiseHandshake(
                pattern: mode.pattern, role: .initiator, prologue: AtriumWire.prologue(hostId: hostId),
                localStatic: deviceKey, remoteStatic: hostKey, psk: psk)
            let first = try handshake.writeMessage(payload: payload)
            do {
                try await socket.send(AtriumWire.firstFrame(mode: mode, noiseMessage: first))
            } catch {
                throw RemoteError.socketClosed
            }
            let second: Data
            do {
                second = try await socket.receive()
            } catch {
                throw RemoteError.closedDuringHandshake
            }
            let replyBytes = try handshake.readMessage(second)
            let result = try handshake.split()
            let channel = SecureChannel(
                socket: socket, transport: result.transport, handshakeHash: result.handshakeHash)
            do {
                return (try RemoteJSON.decode(HandshakeReply.self, from: replyBytes), channel)
            } catch {
                await channel.close()
                throw error
            }
        } catch let error as NoiseError {
            socket.close()
            throw .noise(error)
        } catch let error as RemoteError {
            socket.close()
            throw error
        } catch {
            socket.close()
            throw .socketClosed
        }
    }
}
