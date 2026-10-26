import AtriumNoiseSpike
import AtriumRemoteSpike
import CryptoKit
import Foundation
import Observation
import UIKit

/// The spike's whole state: pairing, the saved Mac, the daily connection and a log.
///
/// - Remarks: One Mac only; the real app keeps a list (SPEC-0005 "iOS App · 存储").
/// - Side effects: Opens WebSockets, reads and writes the keychain, runs heartbeat tasks.
@MainActor @Observable
final class SpikeModel {
    /// Where the flow stands, for the screen.
    enum Phase: Equatable {
        case idle
        case working(String)
        /// Pairing code shown, waiting for the Mac.
        case confirming(code: String)
        case connected
        case failed(String)
    }

    var linkText = ""
    private(set) var phase = Phase.idle
    private(set) var host: HostRecord?
    private(set) var deviceFingerprint = ""
    private(set) var lastRTT: Duration?
    private(set) var heartbeatsAnswered = 0
    private(set) var log: [String] = []

    private let keychain = Keychain()
    private var channel: SecureChannel?
    private var tasks: [Task<Void, Never>] = []
    private var tracker = HeartbeatTracker<ContinuousClock.Instant>()
    private let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"

    /// Loads the saved Mac and the device key, and takes a link from the launch arguments.
    ///
    /// - Remarks: `-pairLink <link>` pre-fills the field, `-autoPair YES` starts pairing and
    ///   `-autoConnect YES` connects to the saved Mac, so `run-sim.sh` can drive the simulator
    ///   without typing.
    /// - Side effects: Reads (and on first launch writes) the keychain.
    init() {
        do {
            let key = try keychain.deviceKey()
            deviceFingerprint = Data(SHA256.hash(data: key.publicKey.rawRepresentation).prefix(4)).hex
            host = try keychain.read(HostRecord.account(pending: false)).flatMap {
                try? JSONDecoder().decode(HostRecord.self, from: $0)
            }
            note("钥匙串可用，设备公钥指纹 \(deviceFingerprint)")
        } catch {
            note("钥匙串不可用：\(error)")
            phase = .failed("钥匙串不可用")
        }
        linkText = UserDefaults.standard.string(forKey: "pairLink") ?? ""
        if UserDefaults.standard.bool(forKey: "autoPair"), !linkText.isEmpty {
            pair()
        } else if UserDefaults.standard.bool(forKey: "autoConnect"), host != nil {
            connect()
        }
    }

    /// Pairs with the Mac in ``linkText``: IKpsk2, key confirmation, code, then `paired`.
    ///
    /// - Side effects: Writes the pending record to the keychain, opens a WebSocket, and on
    ///   success saves the host record and goes on to `hello` and a daily connection.
    func pair() {
        disconnect()
        let link: PairingLink
        do {
            link = try PairingLink(linkText)
        } catch {
            phase = .failed("这不是 Atrium 的配对链接")
            return
        }
        let pending = HostRecord(
            hostId: link.hostId, relay: link.relay.absoluteString, hostKey: link.hostKey.base64URL,
            hostName: link.hostName, deviceId: nil)
        let deviceKey: Curve25519.KeyAgreement.PrivateKey
        do {
            deviceKey = try keychain.deviceKey()
            try keychain.write(HostRecord.account(pending: true), JSONEncoder().encode(pending))
        } catch {
            phase = .failed("钥匙串不可用")
            return
        }
        let endpoint = clientEndpoint(relay: link.relay, hostId: link.hostId)
        note("连接 \(endpoint.absoluteString)")
        phase = .working("正在连接 \(link.hostName)…")
        let socket = WebSocketFrameSocket(url: endpoint)
        let info = DeviceInfo(deviceName: UIDevice.current.name, model: Self.modelIdentifier, appVersion: appVersion)
        start {
            do {
                let result = try await RemoteClient.pair(
                    link: link, deviceKey: deviceKey, info: info, socket: socket,
                    onCode: { code in await self.showCode(code) })
                var record = pending
                record.deviceId = result.deviceId
                record.hostName = result.hostName.isEmpty ? pending.hostName : result.hostName
                try? self.keychain.write(HostRecord.account(pending: false), JSONEncoder().encode(record))
                try? self.keychain.delete(HostRecord.account(pending: true))
                self.host = record
                self.note("已配对，deviceId \(result.deviceId)，已写入钥匙串")
                let welcome = try await RemoteClient.hello(channel: result.channel, deviceId: result.deviceId)
                self.note("配对通道上收到 welcome（协议 \(welcome.protocolVersion)）")
                await result.channel.close()
                self.connect()
            } catch {
                self.fail(error, socket: socket, pairing: true)
            }
        }
    }

    /// Connects to the saved Mac with IK, sends `hello`, and keeps heartbeats going.
    ///
    /// - Side effects: Opens a WebSocket; starts the receive and heartbeat tasks.
    func connect() {
        disconnect()
        guard let host, let deviceId = host.deviceId, let relay = URL(string: host.relay),
            let hostKey = Data(base64URL: host.hostKey)
        else {
            phase = .failed("还没有配对过的 Mac")
            return
        }
        let deviceKey: Curve25519.KeyAgreement.PrivateKey
        do {
            deviceKey = try keychain.deviceKey()
        } catch {
            phase = .failed("钥匙串不可用")
            return
        }
        phase = .working("正在连接 \(host.hostName)（IK）…")
        let socket = WebSocketFrameSocket(url: clientEndpoint(relay: relay, hostId: host.hostId))
        let appVersion = appVersion
        start {
            do {
                let result = try await RemoteClient.connect(
                    hostId: host.hostId, hostKey: hostKey, deviceKey: deviceKey, appVersion: appVersion,
                    socket: socket)
                guard result.deviceId == deviceId else {
                    await result.channel.close()
                    self.phase = .failed("Mac 认出的设备 id 不一致")
                    return
                }
                let welcome = try await RemoteClient.hello(channel: result.channel, deviceId: deviceId)
                self.note("IK 通道建立，welcome：hostVersion \(welcome.hostVersion ?? "?")")
                self.channel = result.channel
                self.tracker = HeartbeatTracker()
                self.heartbeatsAnswered = 0
                self.phase = .connected
                self.startHeartbeats(result.channel)
                try await self.receive(result.channel)
            } catch {
                self.fail(error, socket: socket, pairing: false)
            }
        }
    }

    /// Closes the channel and stops all tasks.
    ///
    /// - Side effects: Closes the WebSocket; cancels tasks.
    func disconnect() {
        for task in tasks { task.cancel() }
        tasks = []
        if let channel {
            Task { await channel.close() }
        }
        channel = nil
    }

    /// Forgets the Mac: deletes its records from the keychain.
    ///
    /// - Side effects: Closes the connection; writes the keychain.
    func forget() {
        disconnect()
        try? keychain.delete(HostRecord.account(pending: false))
        try? keychain.delete(HostRecord.account(pending: true))
        host = nil
        phase = .idle
        note("已忘掉这台 Mac")
    }

    /// Runs `work` as a tracked task on the main actor.
    ///
    /// - Side effects: Starts a task.
    private func start(_ work: @escaping @MainActor () async -> Void) {
        tasks.append(Task { await work() })
    }

    /// Shows the pairing code.
    ///
    /// - Side effects: Updates the screen.
    private func showCode(_ code: String) {
        phase = .confirming(code: code)
        note("校验码 \(PairingCode.display(code))，等 Mac 确认")
    }

    /// Sends heartbeats per ``HeartbeatTracker``; two misses end the connection.
    ///
    /// - Side effects: Starts a task that sends on the channel once a second at most.
    private func startHeartbeats(_ channel: SecureChannel) {
        start {
            while !Task.isCancelled {
                switch self.tracker.tick(at: .now) {
                case .wait: break
                case .send:
                    self.tracker.sent(at: .now)
                    try? await channel.sendHeartbeat()
                case .reconnect:
                    self.note("心跳连续 2 次没有回应")
                    await channel.close()
                    return
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    /// Handles events until the channel closes.
    ///
    /// - Side effects: Updates the screen and the log; deletes the Mac's records on `revoked`.
    private func receive(_ channel: SecureChannel) async throws {
        while true {
            switch try await channel.nextEvent() {
            case .heartbeat:
                note("宿主心跳，已回应")
            case .heartbeatAck:
                lastRTT = tracker.acknowledged(at: .now)
                heartbeatsAnswered += 1
            case .message(let body):
                note("收到消息 \(body.count) 字节")
            case .control(let body):
                if (try? RemoteJSON.decode(ControlMessage.self, from: body)) == .revoked {
                    note("收到 revoked（经 Noise 认证），删除本机数据")
                    forget()
                    phase = .failed("这台手机已被撤销")
                    return
                }
                note("收到控制消息 \(String(decoding: body, as: UTF8.self))")
            }
        }
    }

    /// Turns a failure into the screen's wording (SPEC-0005 "撤销", design-language "配对").
    ///
    /// - Remarks: Only refusals inside the Noise channel delete data; the WebSocket close reason
    ///   comes from the relay, which may lie, so it is only shown.
    /// - Side effects: Updates the screen and the log; may delete the Mac's records.
    private func fail(_ error: any Error, socket: WebSocketFrameSocket, pairing: Bool) {
        let close = socket.closeDescription.map { "（\($0)）" } ?? ""
        note("失败：\(error)\(close)")
        guard !Task.isCancelled else { return }
        switch error as? RemoteError {
        case .rejected(let reason):
            switch reason {
            case "pairing_busy": phase = .failed("已被别的手机占用")
            case "rejected": phase = .failed("Mac 拒绝了这次配对")
            case "timeout": phase = .failed("Mac 上没有及时确认")
            case "cancelled", "disconnected": phase = .failed("配对已取消")
            case "version_mismatch": phase = .failed("Mac 上的 Atrium 和 App 版本不一致")
            case "device_unknown", "revoked":
                forget()
                phase = .failed("这台手机已被撤销")
            default: phase = .failed("Mac 拒绝了：\(reason)")
            }
        case .closedDuringHandshake where pairing, .noise(.decryptFailed) where pairing:
            phase = .failed(close.contains("4404") ? "Mac 不在线\(close)" : "二维码已失效")
        default:
            phase = .failed("连接断开\(close)")
        }
    }

    /// Appends a timestamped line to the log.
    ///
    /// - Side effects: Updates the screen.
    private func note(_ text: String) {
        let time = Date.now.formatted(date: .omitted, time: .standard)
        log.append("\(time)  \(text)")
        if log.count > 200 { log.removeFirst(log.count - 200) }
    }

    /// The hardware model, such as `iPhone18,1`; the simulated one on the simulator.
    static var modelIdentifier: String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}

extension Data {
    /// Lower-case hex.
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
