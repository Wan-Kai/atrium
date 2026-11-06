import type { AtriumClient } from "@atrium/client";
import { useEffect } from "react";
import { type StoreApi, useStore } from "zustand";
import { Composer } from "../chat/composer";
import { ModelPicker } from "../chat/model-picker";
import { pageModel } from "../state/new-workspace";
import { pageDrafts } from "../state/use-draft";
import { type LearningState, NEW_DIRECTION_DRAFT, describeStudyError, launchDirection } from "./learning";

/**
 * The new-direction page: only an input box, as the new-workspace page.
 *
 * @remarks
 * SPEC-0008 ("新建方向"; prototype screen 2): no form and no dialog; nothing is made until the
 * first message goes (`launchDirection`), so leaving the page leaves nothing. The model button
 * chooses the model the discussion starts on, from the models outside any workspace, as chats'.
 * The box keeps its draft, sends nothing while a message is on its way, and has no `/` or `@`
 * menu, as there is no session to ask yet. A failure shows under the box, the message back in it.
 *
 * @sideEffects Subscribes to the study store, the list, the models and the login state; asks for
 * the models; sends commands when the user sends.
 * @param props - The client and the study store.
 * @returns The page.
 */
export function NewDirectionPage({
  client,
  store,
}: {
  readonly client: AtriumClient;
  readonly store: StoreApi<LearningState>;
}) {
  const model = useStore(store, (state) => state.model);
  const sending = useStore(store, (state) => state.sending);
  const failure = useStore(store, (state) => state.failure);
  const list = useStore(client.models(null));
  const preferences = useStore(client.index, (index) => index.preferences);
  const login = useStore(client.setup, (setup) => setup.state?.login ?? null);
  useEffect(() => {
    // Fire and forget: a failed list shows in the model panel.
    void client.loadModels(null);
  }, [client]);
  const shown = pageModel(model, preferences, list);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-[22px] font-semibold text-[var(--text)]">想学点什么？</p>
        <p className="max-w-[460px] text-[length:var(--fs-meta)] leading-relaxed text-[var(--text-muted)]">
          说说为什么学、想学到什么程度、已经会什么。发出去以后 agent 会接着问，方向的名字也由它来起。
        </p>
        {sending ? (
          <p role="status" className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">
            正在建方向…
          </p>
        ) : null}
        {failure === undefined ? null : (
          <p role="alert" className="text-[length:var(--fs-sm)] text-[var(--danger)]">
            {describeStudyError(failure)}
          </p>
        )}
      </div>
      <Composer
        draftKey={NEW_DIRECTION_DRAFT}
        autoFocus
        held={sending}
        onSend={(text, images) => {
          // Fire and forget: the page shows its own failures.
          void launchDirection(store, client, pageDrafts(), { text, images });
        }}
        onUpload={async (image) => (await client.uploadAttachment(image.mimeType, image.data)).attachmentId}
        imagesAllowed={shown?.supportsImage !== false}
        picker={
          <ModelPicker
            shown={shown}
            list={list}
            login={login}
            disabled={sending}
            onOpen={() => {
              // Fire and forget: see above.
              void client.loadModels(null);
            }}
            onRefresh={() => {
              // Fire and forget: see above.
              void client.loadModels(null, true);
            }}
            onChooseModel={(ref) => store.setState({ model: { ref, level: null } })}
            onChooseLevel={(level) => store.setState({ model: { ...store.getState().model, level } })}
          />
        }
      />
      {/* Where a session's status bar goes, as in the empty state. */}
      <div aria-hidden="true" className="h-9 shrink-0" />
    </div>
  );
}
