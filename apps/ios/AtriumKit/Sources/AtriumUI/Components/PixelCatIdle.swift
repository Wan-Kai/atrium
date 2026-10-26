import Foundation

/// When the idle pixel cat blinks, tilts its head or flicks an ear (design-language "像素猫插图").
///
/// - Remark: Every 4 to 6 s the cat does one thing: about two times in three it blinks (0.15 s),
///   otherwise it tilts its head one cell (0.52 s) or flicks its left ear twice (on 0–0.12 s and
///   0.24–0.36 s). The prototype draws lots with `Math.random()` on a timer; here the choice is a
///   pure function of the time and a seed, so tests pin it down and the view needs no timer: action
///   `k` starts at 5k s plus a jitter of ±0.5 s, which keeps consecutive actions 4 to 6 s apart and
///   finds the action for any time without counting from the start. Sleeping cats and Reduce Motion
///   do not use this.
nonisolated enum PixelCatIdle {
  /// What one action does.
  ///
  /// - Remark: See the type above for each one's length.
  enum Action: Equatable, Sendable {
    /// Shut the eyes.
    case blink
    /// Tilt the head.
    case tilt
    /// Flick the left ear twice.
    case flick
  }

  /// The mean time between actions, in seconds.
  static let slot = 5.0

  /// When action `index` starts, in seconds on the clock.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - index: The action's number.
  ///   - seed: The cat's seed.
  /// - Returns: The start.
  static func start(of index: Int64, seed: UInt64) -> Double {
    Double(index) * slot + unit(index, seed: seed, salt: 1) - 0.5
  }

  /// What action `index` does.
  ///
  /// - Remark: See the type: 66% blink, 17% tilt, 17% flick, as the prototype draws.
  /// - SideEffects: none
  /// - Parameters:
  ///   - index: The action's number.
  ///   - seed: The cat's seed.
  /// - Returns: The action.
  static func action(of index: Int64, seed: UInt64) -> Action {
    let draw = unit(index, seed: seed, salt: 2)
    if draw < 0.66 { return .blink }
    return draw < 0.83 ? .tilt : .flick
  }

  /// The cat's pose at a moment.
  ///
  /// - Remark: Only the actions of this slot and the next can cover a moment: one starts at most
  ///   0.5 s before its slot, and none lasts longer than 0.52 s.
  /// - SideEffects: none
  /// - Parameters:
  ///   - time: Seconds on the clock.
  ///   - seed: The cat's seed.
  /// - Returns: The pose.
  static func pose(at time: Double, seed: UInt64) -> PixelCat.Pose {
    let current = Int64((time / slot).rounded(.down))
    for index in [current, current + 1] {
      let elapsed = time - start(of: index, seed: seed)
      guard elapsed >= 0 else { continue }
      switch action(of: index, seed: seed) {
      case .blink where elapsed < 0.15: return PixelCat.Pose(blink: true)
      case .tilt where elapsed < 0.52: return PixelCat.Pose(tilt: true)
      case .flick where elapsed < 0.12 || (elapsed >= 0.24 && elapsed < 0.36): return PixelCat.Pose(flick: true)
      default: continue
      }
    }
    return .rest
  }

  /// The moments after a time when the pose may change, in order.
  ///
  /// - Remark: Each action's start and end (and the flick's middle), so a timeline redraws the
  ///   cat only then instead of every frame.
  /// - SideEffects: none
  /// - Parameters:
  ///   - time: Seconds on the clock.
  ///   - seed: The cat's seed.
  ///   - count: How many to list.
  /// - Returns: Up to `count` moments, all later than `time`.
  static func changes(after time: Double, seed: UInt64, count: Int) -> [Double] {
    var moments: [Double] = []
    var index = Int64((time / slot).rounded(.down)) - 1
    while moments.count < count {
      let begin = start(of: index, seed: seed)
      let offsets: [Double] =
        switch action(of: index, seed: seed) {
        case .blink: [0, 0.15]
        case .tilt: [0, 0.52]
        case .flick: [0, 0.12, 0.24, 0.36]
        }
      moments += offsets.map { begin + $0 }.filter { $0 > time }
      index += 1
    }
    return Array(moments.prefix(count))
  }

  /// A number in [0, 1) for an action, the same for the same inputs.
  ///
  /// - Remark: SplitMix64 over the seed, the index and a salt per question asked of it; enough
  ///   for picking a cat's next move.
  /// - SideEffects: none
  /// - Parameters:
  ///   - index: The action's number.
  ///   - seed: The cat's seed.
  ///   - salt: Which question.
  /// - Returns: The number.
  private static func unit(_ index: Int64, seed: UInt64, salt: UInt64) -> Double {
    var z = seed &+ UInt64(bitPattern: index) &* 0x9E37_79B9_7F4A_7C15 &+ salt &* 0xD1B5_4A32_D192_ED03
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    z ^= z >> 31
    return Double(z >> 11) / Double(UInt64(1) << 53)
  }
}
