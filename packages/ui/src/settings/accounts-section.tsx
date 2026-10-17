import { type AtriumClient, CommandError } from "@atrium/client";
import type { ModelRef, Plans, SetupProvider } from "@atrium/protocol";
import { CaretDown, Key, Plus } from "../design/icons";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { PlanSections } from "../chat/plan-sections";
import { groupByProvider, providerOf } from "../chat/model-choice";
import { KeyForm, type LoginFlow, SignedIn, SubscriptionList, useLoginFlow } from "../setup/login-flow";
import { isLastCredential, keyCandidates, keyedProviders } from "../setup/providers";
import { GHOST_BUTTON, Group, LINK_BUTTON, Row, Tick } from "./parts";

/** A credential waiting for "仍要…" before it goes. */
interface Removing {
  readonly providerId: string;
  readonly method: "oauth" | "api_key";
}

/**
 * The settings' models and accounts: subscriptions, their usage, API keys and the title model.
 *
 * @remarks
 * SPEC-0001 ("设置 · 模型与账户"): the same subscription list and login as first launch, with
 * "退出" on a signed-in row; every subscription's usage the host found, as the status bar's plan
 * card shows it ("M1.14 的套餐总览"); API keys listed without the key, a stored one removable and
 * one from the environment not; logging out and removing a key ask first only when it is the last
 * credential. Credentials live in pi, so the terminal's pi sees the same.
 *
 * @sideEffects Subscribes to the client's setup, login state and plans; sends login commands and
 * `logout`; opens addresses; may ask for the chats' models.
 * @param props - The client and how to open an address.
 * @returns The section.
 */
export function AccountsSection({
  client,
  openUrl,
}: {
  readonly client: AtriumClient;
  readonly openUrl: (url: string) => void;
}) {
  const setup = useStore(client.setup);
  const plans = useStore(client.plans);
  const flow = useLoginFlow(client, openUrl);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const login = setup.state?.login;
  if (login === undefined) {
    return (
      <p className="text-[length:var(--fs-meta)] text-[var(--text-muted)]">
        {setup.status === "failed" ? "读不到登录状态" : "正在读取…"}
      </p>
    );
  }
  if (login.state === "unavailable") {
    return (
      <>
        <Group title="登录">
          <p className="px-3 text-[length:var(--fs-meta)] text-[var(--text-muted)]">
            Atrium 加载不了你装的 pi，没法在这里登录。在终端运行 <code className="font-mono">pi</code>，输入{" "}
            <code className="font-mono">/login</code>。
          </p>
        </Group>
        <PlanGroup plans={plans} />
      </>
    );
  }
  const providers = login.providers;

  /**
   * Removes a provider's credential, asking first when it is the last one.
   *
   * @remarks
   * See `AccountsSection`. The setup is asked again once it went.
   *
   * @sideEffects May send `logout`; updates the section's state.
   * @param provider - The provider.
   * @param method - What goes: the subscription or the key.
   * @param name - What the row calls the provider.
   * @param confirmed - Whether "仍要…" was chosen.
   */
  const remove = (provider: SetupProvider, method: Removing["method"], name: string, confirmed: boolean): void => {
    setProblem(null);
    if (!confirmed && isLastCredential(providers, provider.providerId)) {
      setRemoving({ providerId: provider.providerId, method });
      return;
    }
    setRemoving(null);
    // Fire and forget: the failure is shown.
    void client.logout(provider.providerId).catch((error: unknown) => {
      setProblem(
        error instanceof CommandError && error.code === "logout_failed"
          ? `pi 没能去掉 ${name} 的凭据`
          : "没做成，稍后再试",
      );
    });
  };

  /**
   * What a signed-in row offers: "退出", or the question before the last credential goes.
   *
   * @remarks
   * See `remove`.
   *
   * @sideEffects none; the buttons call `remove`.
   * @param provider - The provider.
   * @param method - What goes.
   * @param name - What the row calls the provider.
   * @returns The controls.
   */
  const removeControls = (provider: SetupProvider, method: Removing["method"], name: string) => {
    const verb = method === "oauth" ? "退出" : "删除";
    if (removing?.providerId === provider.providerId && removing.method === method) {
      return (
        <>
          <span role="alert" className="text-[var(--attn-text)]">
            {verb}后没有能用的模型，新会话没法开始
          </span>
          <button type="button" className={GHOST_BUTTON} onClick={() => setRemoving(null)}>
            取消
          </button>
          <button type="button" className={GHOST_BUTTON} onClick={() => remove(provider, method, name, true)}>
            仍要{verb}
          </button>
        </>
      );
    }
    return (
      <button
        type="button"
        className={GHOST_BUTTON}
        aria-label={`${verb} ${name}`}
        onClick={() => remove(provider, method, name, false)}
      >
        {verb}
      </button>
    );
  };

  return (
    <>
      {problem === null && flow.problem === null ? null : (
        <p role="alert" className="mb-4 text-[length:var(--fs-sm)] text-[var(--danger)]">
          {problem ?? flow.problem}
        </p>
      )}
      <Group
        title="订阅登录"
        description="用已有的订阅登录。凭据保存在 pi 里，终端里的 pi 也能直接用。"
        footer="点“登录”会打开浏览器，在官网完成授权后自动回到这里。"
      >
        <SubscriptionList
          providers={providers}
          flow={flow}
          openUrl={openUrl}
          signedInControls={(provider, title) =>
            provider.signedIn?.method === "oauth" ? removeControls(provider, "oauth", title) : null
          }
        />
      </Group>
      <PlanGroup plans={plans} />
      <Group
        title="API Key"
        description="没有订阅也可以用服务商的 API Key。这里只显示保存过 Key 的服务商，不显示 Key 本身。"
        footer={
          <>
            Key 只写在本机的 <code className="font-mono">~/.pi/agent/auth.json</code>，终端里的 pi 也能用。
          </>
        }
      >
        {keyedProviders(providers).map((provider) => (
          <Row
            key={provider.providerId}
            compact
            lead={
              <span className="inline-flex w-8 shrink-0 justify-center text-[var(--text-muted)]">
                <Key size={17} />
              </span>
            }
            label={provider.name}
            controls={
              provider.signedIn?.stored === true ? (
                <>
                  <SignedIn>已保存</SignedIn>
                  {removeControls(provider, "api_key", provider.name)}
                </>
              ) : (
                <span>来自环境变量</span>
              )
            }
          />
        ))}
        <KeyAdder flow={flow} candidates={keyCandidates(providers)} openUrl={openUrl} />
      </Group>
      <TitleModel client={client} />
    </>
  );
}

/**
 * "套餐用量": every subscription's usage the host found, or how it comes.
 *
 * @remarks
 * SPEC-0001 ("M1.14 的套餐总览"): as the status bar's plan card draws it, with none marked
 * "当前", for the settings are no session's. Sessions' pi find it, not the login program, so it
 * shows when Atrium cannot log in through pi too.
 *
 * @sideEffects Draws itself again every minute while it lists usage.
 * @param props - Every subscription's usage found.
 * @returns The group.
 */
function PlanGroup({ plans }: { readonly plans: Plans }) {
  return (
    <Group title="套餐用量" description="各订阅还剩多少、什么时候重置，借 pi 的登录查，每分钟最多一次。">
      <div className="px-3 text-[length:var(--fs-meta)] text-[var(--text-muted)]">
        {plans.length === 0 ? (
          <p>打开会话后，Atrium 会借 pi 的登录查各订阅的用量</p>
        ) : (
          <PlanSections plans={plans} provider={null} />
        )}
      </div>
    </Group>
  );
}

/**
 * "添加 API Key", opening a row to choose the provider and paste the key.
 *
 * @remarks
 * See `AccountsSection`. Saving logs in with the key through pi, which may ask more, such as an
 * account id; the row closes once the login succeeds.
 *
 * @sideEffects Starts a login through `flow`.
 * @param props - The flow, the providers a key can be added for, and how to open an address.
 * @returns The row.
 */
function KeyAdder({
  flow,
  candidates,
  openUrl,
}: {
  readonly flow: LoginFlow;
  readonly candidates: readonly SetupProvider[];
  readonly openUrl: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return open ? (
    <Row
      compact
      label={<KeyForm flow={flow} candidates={candidates} openUrl={openUrl} onClose={() => setOpen(false)} />}
    />
  ) : (
    <Row
      compact
      label={
        <button
          type="button"
          className={`${LINK_BUTTON} inline-flex items-center gap-1.5 text-[length:var(--fs-meta)]`}
          disabled={candidates.length === 0}
          onClick={() => setOpen(true)}
        >
          <Plus size={13} />
          添加 API Key
        </button>
      }
    />
  );
}

/**
 * The model titles are made with: the session's, or one chosen.
 *
 * @remarks
 * SPEC-0001 ("设置 · 模型与账户"): the choices are the models pi lists for the providers signed
 * in, asked outside any workspace, as for chats. A chosen model pi no longer lists stays chosen, with a note that titles
 * use the session's model meanwhile.
 *
 * @sideEffects Subscribes to the client's list and the models outside any workspace, asking for them when shown;
 * sends `set_preferences` when one is chosen.
 * @param props - The client.
 * @returns The group.
 */
function TitleModel({ client }: { readonly client: AtriumClient }) {
  const chosen = useStore(client.index, (index) => index.preferences.titleModel);
  const models = useStore(client.models(null));
  useEffect(() => {
    // Fire and forget: the failure lands in the list.
    void client.loadModels(null);
  }, [client]);
  const listed =
    chosen === null ||
    models.models.some((model) => model.providerId === chosen.providerId && model.modelId === chosen.modelId);

  /**
   * Chooses the title model, or `null` for the session's.
   *
   * @remarks
   * The list shows it at once; the host keeps it.
   *
   * @sideEffects Sends `set_preferences`.
   * @param model - The model.
   */
  const choose = (model: ModelRef | null): void => {
    // Fire and forget: the choice shows at once and the host keeps it.
    void client.setPreferences({ titleModel: model }).catch(() => undefined);
  };

  return (
    <Group
      title="自动生成标题"
      footer="默认和会话用同一个模型。选一个更便宜、更快的模型能省一点用量；只列出已登录的服务商。"
    >
      <Row
        label="生成标题用的模型"
        detail={
          <>
            新会话第一轮结束后用它起标题
            {!listed && models.status === "ready" ? (
              <span className="block text-[var(--attn-text)]">已不可用，暂时改用会话的模型起标题</span>
            ) : null}
          </>
        }
        controls={
          <MenuButton
            field
            label="生成标题用的模型"
            content={
              <>
                {chosen === null ? (
                  <span>跟随会话的模型</span>
                ) : (
                  <>
                    <span className="truncate font-mono text-[length:var(--fs-sm)]">{chosen.modelId}</span>
                    <span className="text-[var(--text-dim)]">{providerOf(chosen.providerId).name}</span>
                  </>
                )}
                <CaretDown size={11} className="text-[var(--text-dim)]" />
              </>
            }
          >
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={chosen === null}
                  className={MENU_ITEM}
                  onClick={() => {
                    close();
                    choose(null);
                  }}
                >
                  <Tick on={chosen === null} />
                  <span className="min-w-0 flex-1">
                    跟随会话的模型
                    <small className="block text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                      和这个会话用同一个模型
                    </small>
                  </span>
                </button>
                {models.status === "loading" && models.models.length === 0 ? (
                  <div className="px-2 py-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">正在读取模型…</div>
                ) : null}
                {models.status === "failed" ? (
                  <div className="px-2 py-1.5 text-[length:var(--fs-sm)] text-[var(--text-dim)]">读不到模型列表</div>
                ) : null}
                {groupByProvider(models.models).map((group) => (
                  <div key={group.providerId} role="group" aria-label={providerOf(group.providerId).name}>
                    <div className="mx-1.5 my-1 h-[0.5px] bg-[var(--line)]" />
                    <div className="px-2 pt-1.5 pb-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                      {providerOf(group.providerId).name}
                    </div>
                    {group.models.map((model) => {
                      const on = chosen?.providerId === model.providerId && chosen.modelId === model.modelId;
                      return (
                        <button
                          key={model.modelId}
                          type="button"
                          role="menuitemradio"
                          aria-checked={on}
                          className={MENU_ITEM}
                          onClick={() => {
                            close();
                            choose({ providerId: model.providerId, modelId: model.modelId });
                          }}
                        >
                          <Tick on={on} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-sm)]">
                            {model.modelId}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </>
            )}
          </MenuButton>
        }
      />
    </Group>
  );
}
