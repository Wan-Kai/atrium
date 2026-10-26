/// A value that is either JSON `null` or present, for fields that may also be left out.
///
/// - Remark: A few commands use "left out" and "`null`" for different things: `set_preferences`
///   leaves a setting alone when the field is missing and clears it when it is `null`. Swift's
///   single `Optional` cannot tell the two apart, so such a field is `Nullable<T>?`: `nil` is left
///   out, `.null` is `null` (testing.md, "协议类型的生成与往返测试").
public enum Nullable<Wrapped: Sendable & Equatable>: Sendable, Equatable {
  /// JSON `null`.
  case null
  /// A value.
  case value(Wrapped)
}
