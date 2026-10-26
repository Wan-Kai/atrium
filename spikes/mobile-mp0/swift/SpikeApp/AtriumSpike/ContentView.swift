import AtriumRemoteSpike
import SwiftUI

/// The spike's single screen: paste a link, see the code, watch the connection.
///
/// - Remarks: Deliberately plain; it only borrows the warm background and the serif title and
///   code from design-language "手机端" so screenshots read as Atrium.
/// - Side effects: Calls into ``SpikeModel`` on taps.
struct ContentView: View {
    @Bindable var model: SpikeModel

    private let background = Color(red: 0xfa / 255, green: 0xf9 / 255, blue: 0xf5 / 255)
    private let secondary = Color(red: 0x86 / 255, green: 0x82 / 255, blue: 0x7a / 255)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Atrium")
                    .font(.system(size: 40, weight: .semibold, design: .serif))
                Text("MP0 互通实验 · 配对与握手")
                    .font(.system(size: 13))
                    .foregroundStyle(secondary)

                status

                VStack(alignment: .leading, spacing: 8) {
                    Text("配对链接").font(.system(size: 13)).foregroundStyle(secondary)
                    TextField("atrium://pair?v=1&relay=…", text: $model.linkText, axis: .vertical)
                        .font(.system(size: 13, design: .monospaced))
                        .lineLimit(2...5)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(10)
                        .background(Color(red: 0xf3 / 255, green: 0xf1 / 255, blue: 0xeb / 255), in: .rect(cornerRadius: 10))
                    HStack {
                        Button("粘贴") { model.linkText = UIPasteboard.general.string ?? "" }
                        Spacer()
                        Button("配对") { model.pair() }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.linkText.isEmpty)
                    }
                }

                if let host = model.host {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(host.hostName.isEmpty ? host.hostId : host.hostName).font(.system(size: 16, weight: .medium))
                        Text("\(host.deviceId ?? "待确认") · \(host.relay)")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(secondary)
                        HStack {
                            Button("日常连接（IK）") { model.connect() }
                            Spacer()
                            Button("忘掉这台 Mac", role: .destructive) { model.forget() }
                        }
                        .font(.system(size: 15))
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("记录 · 设备指纹 \(model.deviceFingerprint)").font(.system(size: 13)).foregroundStyle(secondary)
                    ForEach(Array(model.log.enumerated().reversed()), id: \.offset) { _, line in
                        Text(line).font(.system(size: 11, design: .monospaced)).foregroundStyle(.primary.opacity(0.8))
                    }
                }
            }
            .padding(24)
        }
        .background(background)
        .foregroundStyle(Color(red: 0x1f / 255, green: 0x1e / 255, blue: 0x1c / 255))
        .preferredColorScheme(.light)
    }

    /// The current step: the pairing code, the connection, or the failure.
    @ViewBuilder private var status: some View {
        switch model.phase {
        case .idle:
            Text("粘贴 Mac 上的配对链接").font(.system(size: 16))
        case .working(let text):
            HStack(spacing: 8) {
                ProgressView()
                Text(text).font(.system(size: 16))
            }
        case .confirming(let code):
            VStack(alignment: .leading, spacing: 6) {
                Text(PairingCode.display(code))
                    .font(.system(size: 48, weight: .regular, design: .serif))
                    .monospacedDigit()
                Text("在 Mac 上核对并确认").font(.system(size: 16))
            }
        case .connected:
            VStack(alignment: .leading, spacing: 4) {
                Text("● 已连接").font(.system(size: 16, weight: .medium)).foregroundStyle(.green)
                Text(
                    "心跳回应 \(model.heartbeatsAnswered) 次"
                        + (model.lastRTT.map { " · 往返 \($0.formatted(.units(allowed: [.milliseconds])))" } ?? "")
                )
                .font(.system(size: 13))
                .foregroundStyle(secondary)
            }
        case .failed(let text):
            Text(text).font(.system(size: 16)).foregroundStyle(Color(red: 0xd4 / 255, green: 0x46 / 255, blue: 0x3d / 255))
        }
    }
}
