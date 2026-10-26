import { useEffect, useRef, useState } from "react";
import { CheckCircle, X } from "../design/icons";
import { useClock } from "../state/clock";

/**
 * Shows the latest remote operation's success as a glass capsule.
 * @remarks Matches design-language's feedback: three seconds, paused on hover/focus; failures
 * remain beside their retry action rather than disappearing on a timer.
 * @sideEffects Schedules a cancellable notice timeout and calls onGone after it expires.
 * @param props - The success wording and dismissal callback.
 * @returns Non-focusing status feedback.
 */
export function PhoneNotice({ text, onGone }: { readonly text: string; readonly onGone: () => void }) {
  const clock = useClock();
  const remaining = useRef(3000);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return undefined;
    const began = clock.now();
    const cancel = clock.after(remaining.current, onGone);
    return () => {
      cancel();
      remaining.current = Math.max(600, remaining.current - (clock.now() - began));
    };
  }, [clock, held, onGone]);
  return (
    <div
      role="status"
      className="atrium-toast phone-notice"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <CheckCircle size={15} />
      <span>{text}</span>
      <button type="button" aria-label="关闭提示" onClick={onGone}>
        <X size={11} />
      </button>
    </div>
  );
}
