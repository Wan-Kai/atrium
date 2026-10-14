import { useMemo } from "react";
import { type Launch, type LaunchStep, baseName } from "../state/new-workspace";
import { MessageImagesContext } from "./message-images";
import { UserBubble } from "./messages";
import { type RailNode, RailMarks } from "./steps";

/** Each step's words on the timeline (SPEC-0001, "M1.11 的新建工作区"). */
const STEP_WORDS: Readonly<Record<LaunchStep, string>> = {
  name: "起名",
  worktree: "创建 worktree",
  session: "启动会话",
  message: "发出消息",
};

/**
 * The rail's node for a step of a launch.
 *
 * @remarks
 * Done before the step going on, failed or going on at it, not started after it.
 *
 * @sideEffects none
 * @param launch - The launch.
 * @param at - The step's place.
 * @returns The node.
 */
function launchNode(launch: Launch, at: number): RailNode {
  if (at < launch.done) return "dot";
  if (at > launch.done) return "wait";
  return launch.failure === undefined ? "live" : "fail";
}

/**
 * The words after a step's name on the timeline.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"): naming says what it goes by, then the name, or that it fell
 * back on a random one; creating the worktree says its branch, unless naming just said it, and its
 * base, once the branch is known.
 *
 * @sideEffects none
 * @param launch - The launch.
 * @param step - The step.
 * @returns The words, or `null` for none.
 */
function stepDetail(launch: Launch, step: LaunchStep): string | null {
  const { worktree, named } = launch;
  if (worktree === null) return null;
  const { branch } = worktree;
  if (step === "name") {
    if (named === null || branch === null) return "按第一条消息";
    return named === "model" ? branch : `没起成，用随机名 ${branch}`;
  }
  if (step !== "worktree" || branch === null) return null;
  return named === "model" ? `基于 ${baseName(worktree.base)}` : `${branch} · 基于 ${baseName(worktree.base)}`;
}

/**
 * What sending from the new-workspace page set going: a timeline of its steps, and the message
 * below it until it has gone.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"); styled as the process rail (design-language, "新建工作区页").
 * The steps say the branch and its base (`stepDetail`). A failed step says why under it, and the message
 * has gone back into the box, so it no longer shows here. Once the message is being sent, the
 * session's own pending copy shows below instead (`sendShown` in the client). The message's
 * images are the previews the page kept.
 *
 * @sideEffects none
 * @param props - The launch, and why its failed step failed.
 * @returns The timeline and the message.
 */
export function LaunchView({ launch, reason }: { readonly launch: Launch; readonly reason: string | null }) {
  const images = useMemo(() => {
    const previews = launch.images.map(({ image }) => image.preview);
    return { sent: () => previews, load: () => Promise.reject(new Error("not sent yet")) };
  }, [launch.images]);
  return (
    <section aria-label="新建工作区的进度" className="mx-auto w-full max-w-[720px] shrink-0 px-6 pt-4">
      <ol>
        {launch.steps.map((step, at) => {
          const node = launchNode(launch, at);
          const detail = stepDetail(launch, step);
          return (
            <li
              key={step}
              className="atrium-step-enter relative min-w-0 pl-[30px]"
              data-testid="launch-step"
              data-state={node}
            >
              <RailMarks node={node} first={at === 0} last={at === launch.steps.length - 1} />
              <div className="atrium-step-line flex min-h-[30px] min-w-0 items-center gap-1.5 text-[length:var(--fs-meta)]">
                <span
                  className={`flex-none ${node === "wait" ? "text-[var(--text-dim)]" : "text-[var(--text-2)]"} ${
                    node === "live" ? "atrium-shimmer" : ""
                  }`}
                >
                  {STEP_WORDS[step]}
                </span>
                {detail === null ? null : <span className="min-w-0 truncate text-[var(--text-dim)]">{detail}</span>}
              </div>
              {node === "fail" && reason !== null ? (
                <p role="alert" className="pb-1.5 text-[length:var(--fs-meta)] text-[var(--danger)]">
                  {reason}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {launch.failure === undefined && launch.done < launch.steps.length - 1 ? (
        <div className="mt-3 opacity-60" data-testid="launch-message">
          <MessageImagesContext value={images}>
            <UserBubble text={launch.text} images={launch.images.length} clientMessageId={launch.id} />
          </MessageImagesContext>
        </div>
      ) : null}
    </section>
  );
}
