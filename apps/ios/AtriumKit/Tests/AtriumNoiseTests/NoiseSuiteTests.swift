import AtriumNoise
import Testing

@Suite("Noise suite")
struct NoiseSuiteTests {
  @Test("names IK and IKpsk2 on X25519, ChaChaPoly and SHA-256, as ADR-0016 fixes them")
  func names() {
    #expect(NoiseSuite.ik.rawValue == "Noise_IK_25519_ChaChaPoly_SHA256")
    #expect(NoiseSuite.ikpsk2.rawValue == "Noise_IKpsk2_25519_ChaChaPoly_SHA256")
    #expect(NoiseSuite.allCases.count == 2)
  }
}
