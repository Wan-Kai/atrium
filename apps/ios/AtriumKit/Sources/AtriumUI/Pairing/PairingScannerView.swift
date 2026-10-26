#if os(iOS)
  import AVFoundation
  import SwiftUI
  import VisionKit

  /// VisionKit QR capture with explicit camera permission and a paste fallback on failure.
  ///
  /// - Remark: Not registered as a system URL handler; only the in-app scanner consumes QR payloads.
  struct PairingScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onUnavailable: () -> Void

    /// Creates the scanner's lifecycle owner.
    ///
    /// - Remark: Camera access starts only after this controller appears.
    /// - SideEffects: Creates the controller.
    /// - Parameter context: SwiftUI context.
    /// - Returns: The camera container.
    func makeUIViewController(context: Context) -> CameraController {
      CameraController(onCode: onCode, onUnavailable: onUnavailable)
    }

    /// Keeps the callbacks current without restarting capture.
    ///
    /// - Remark: State changes do not re-request permission.
    /// - SideEffects: Updates callbacks.
    /// - Parameters:
    ///   - controller: The camera container.
    ///   - context: SwiftUI context.
    func updateUIViewController(_ controller: CameraController, context: Context) {
      controller.onCode = onCode
      controller.onUnavailable = onUnavailable
    }

    /// Stops capture when SwiftUI dismisses the sheet.
    ///
    /// - Remark: Explicit cleanup also covers removal without a disappearance animation.
    /// - SideEffects: Stops the camera and cancels permission work.
    /// - Parameters:
    ///   - controller: The camera container.
    ///   - coordinator: Unused coordinator.
    static func dismantleUIViewController(_ controller: CameraController, coordinator: ()) {
      controller.stop()
    }
  }

  /// Owns camera capture and its asynchronous permission request for one presentation.
  ///
  /// - Remark: Native lifecycle callbacks keep camera side effects out of SwiftUI body evaluation.
  final class CameraController: UIViewController, DataScannerViewControllerDelegate {
    var onCode: (String) -> Void
    var onUnavailable: () -> Void
    private var scanner: DataScannerViewController?
    private var cameraTask: Task<Void, Never>?
    private var capture = PairingCodeCapture()

    /// Stores callbacks before the camera is created.
    ///
    /// - Remark: Constructing this controller does not ask for permission.
    /// - SideEffects: none
    /// - Parameters:
    ///   - onCode: One scanned payload.
    ///   - onUnavailable: Permission, hardware or capture failure.
    init(onCode: @escaping (String) -> Void, onUnavailable: @escaping () -> Void) {
      self.onCode = onCode
      self.onUnavailable = onUnavailable
      super.init(nibName: nil, bundle: nil)
    }

    /// Disallows storyboard construction.
    ///
    /// - Remark: SwiftUI constructs this controller with callbacks.
    /// - SideEffects: none
    /// - Parameter coder: Unused archive.
    required init?(coder: NSCoder) { return nil }

    /// Requests camera permission and then starts QR-only capture.
    ///
    /// - Remark: Unsupported simulators and denied cameras use the same visible paste fallback.
    /// - SideEffects: May show the system permission prompt and start the camera.
    /// - Parameter animated: UIKit transition flag.
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      cameraTask = Task { [weak self] in
        guard DataScannerViewController.isSupported else {
          self?.onUnavailable()
          return
        }
        let allowed = await AVCaptureDevice.requestAccess(for: .video)
        guard let self, !Task.isCancelled else { return }
        guard allowed, DataScannerViewController.isAvailable else {
          self.onUnavailable()
          return
        }
        let scanner = DataScannerViewController(
          recognizedDataTypes: [.barcode(symbologies: [.qr])],
          recognizesMultipleItems: false, isHighlightingEnabled: true)
        scanner.delegate = self
        self.scanner = scanner
        self.addChild(scanner)
        scanner.view.frame = self.view.bounds
        scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        self.view.addSubview(scanner.view)
        scanner.didMove(toParent: self)
        do { try scanner.startScanning() } catch { self.onUnavailable() }
      }
    }

    /// Stops capture as soon as the sheet leaves the screen.
    ///
    /// - Remark: The camera is never held behind the pairing confirmation page.
    /// - SideEffects: Cancels work and stops capture.
    /// - Parameter animated: UIKit transition flag.
    override func viewWillDisappear(_ animated: Bool) {
      stop()
      super.viewWillDisappear(animated)
    }

    /// Releases camera work.
    ///
    /// - Remark: Safe to call more than once.
    /// - SideEffects: Cancels permission work and stops scanning.
    func stop() {
      cameraTask?.cancel()
      cameraTask = nil
      scanner?.stopScanning()
    }

    /// Delivers the first Atrium pairing candidate only.
    ///
    /// - Remark: Link validation remains in PairingModel; camera callbacks never connect directly.
    /// - SideEffects: Stops scanning and calls the screen callback.
    /// - Parameters:
    ///   - dataScanner: The active scanner.
    ///   - addedItems: Newly recognized items.
    ///   - allItems: All visible items.
    func dataScanner(
      _ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]
    ) {
      for item in addedItems {
        if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue,
          let text = capture.accept(payload)
        {
          stop()
          onCode(text)
          return
        }
      }
    }

    /// Falls back to explicit paste when capture becomes unavailable.
    ///
    /// - Remark: Raw camera errors are not displayed or logged.
    /// - SideEffects: Stops capture and calls the fallback callback.
    /// - Parameters:
    ///   - dataScanner: The active scanner.
    ///   - error: The camera availability error.
    func dataScanner(
      _ dataScanner: DataScannerViewController,
      becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
    ) {
      stop()
      onUnavailable()
    }
  }
#endif
