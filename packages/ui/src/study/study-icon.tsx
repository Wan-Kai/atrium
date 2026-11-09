import type { Direction, SessionSummary, StudyKind } from "@atrium/protocol";
import { BookOpen, Idea, Message, Note, Quiz, Target, TerminalWindow } from "../design/icons";
import { sessionTitle } from "../sidebar/names";
import { studyLabel } from "./progress";

/** Each use's icon (design-language "学习模式", "宿主开的学习会话第一轮"). */
const ICONS = {
  discuss: Message,
  ask: Message,
  plan: Target,
  lesson: BookOpen,
  quiz: Quiz,
  exam: Quiz,
  feynman: Idea,
  sheet: Note,
  project: TerminalWindow,
} as const satisfies Readonly<Record<StudyKind, unknown>>;

/**
 * A use's icon.
 *
 * @remarks
 * The discussion and asking keep the message icon ML1 drew; the others are Hugeicons named in
 * design-language.
 *
 * @sideEffects none
 * @param props - The use, the size and the class.
 * @returns The icon.
 */
export function StudyIcon({
  kind,
  size,
  className,
}: {
  readonly kind: StudyKind;
  readonly size: number;
  readonly className?: string;
}) {
  const Icon = ICONS[kind];
  return <Icon size={size} aria-hidden {...(className === undefined ? {} : { className })} />;
}

/**
 * A session's title: its own, else for a session the host opened for a use, the use and step.
 *
 * @remarks
 * A session the host opened starts with no message of yours, so until pi names it the use says
 * what it is: "上课 · 第 2 级第 4 步" (design-language "学习模式").
 *
 * @sideEffects none
 * @param session - The session.
 * @param direction - Its direction, for the level and step numbers.
 * @returns The title.
 */
export function studySessionTitle(
  session: Pick<SessionSummary, "name" | "prompt" | "state" | "study">,
  direction: Pick<Direction, "progress"> | undefined,
): string {
  const { study } = session;
  if (
    session.name !== null ||
    session.prompt !== null ||
    study === null ||
    study.kind === "discuss" ||
    study.kind === "ask"
  ) {
    return sessionTitle(session);
  }
  return studyLabel(study, direction?.progress ?? null);
}
