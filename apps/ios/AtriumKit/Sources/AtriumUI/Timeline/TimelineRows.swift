import Observation

/// Keeps stable row identities while a transcript's current reply changes.
///
/// - Remark: The original value-array timeline rebuilt every row builder on each update even when
///   `.equatable()` prevented their bodies from running. This collection changes only for structural
///   changes; each row's observable value carries content updates. This is a UI projection, not a
///   second sync store: the supplied snapshot remains authoritative and removed rows are released.
@Observable
final class TimelineRows {
  /// The ordered row references consumed by List/ForEach.
  private(set) var items: [Row] = []

  /// One stable identity with independently observable content.
  ///
  /// - Remark: Its id never changes; reordering retains the same object and its view state.
  @Observable
  final class Row: Identifiable {
    /// Transcript-provided stable identity.
    let id: String
    /// Latest immutable display model.
    fileprivate(set) var value: TimelineRow

    /// Wraps the first value for an identity.
    ///
    /// - Remark: Later snapshots update the value rather than replace the wrapper.
    /// - SideEffects: none
    /// - Parameter value: The initial row.
    init(_ value: TimelineRow) {
      self.id = value.id
      self.value = value
    }
  }

  /// Reconciles a complete display snapshot using its unique transcript ids.
  ///
  /// - Remark: Equality checks avoid publishing identical snapshots; no historical values are kept.
  /// - SideEffects: Updates changed row values and the ordered collection when needed.
  /// - Parameter rows: Authoritative rows with unique ids.
  func apply(_ rows: [TimelineRow]) {
    if rows.count == items.count && zip(rows, items).allSatisfy({ $0.id == $1.id }) {
      for (incoming, row) in zip(rows, items) where row.value != incoming { row.value = incoming }
      return
    }
    let previous = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
    let next = rows.map { incoming in
      let row = previous[incoming.id] ?? Row(incoming)
      if row.value != incoming { row.value = incoming }
      return row
    }
    items = next
  }
}
