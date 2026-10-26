import type { AtriumClient } from "@atrium/client";
import type { Appearance } from "@atrium/protocol";
import { Folder, Info, Monitor, Moon, Palette, Phone, Sun, Terminal, User, WarningCircle, X } from "../design/icons";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { describeConnection } from "../app/connection-status";
import { piUpdateAvailable } from "../setup/pi-version";
import { AccountsSection } from "./accounts-section";
import { BUTTON, Group, PiMark, Row } from "./parts";
import { PiSection } from "./pi-section";
import { type ConfigGuard, PiConfigGroup } from "./pi-config-group";
import { ProxyGroup } from "./proxy-group";
import { ProjectsSection } from "./projects-section";
import { PhoneSection } from "./phone-section";

/** A part of the settings. */
export type SettingsSection = "appearance" | "accounts" | "projects" | "pi" | "phone" | "about";

/** The settings' parts, in order, with their names, icons and what each is for. */
const SECTIONS: readonly {
  readonly id: SettingsSection;
  readonly name: string;
  readonly icon: ReactNode;
  readonly lead: string;
}[] = [
  { id: "appearance", name: "外观", icon: <Palette size={16} />, lead: "浅色、深色，或者跟着 macOS 走。" },
  {
    id: "accounts",
    name: "模型与账户",
    icon: <User size={16} />,
    lead: "登录模型服务商、管理 API Key，选择起标题用的模型。凭据都保存在 pi 里。",
  },
  { id: "projects", name: "项目", icon: <Folder size={16} />, lead: "每个项目的主干分支。" },
  {
    id: "pi",
    name: "pi",
    icon: <Terminal size={16} />,
    lead: "Atrium 用的就是你装的 pi：位置、版本、更新、网络代理和配置文件。",
  },
  {
    id: "phone",
    name: "手机",
    icon: <Phone size={16} />,
    lead: "用 iPhone 经你自己的 relay 连回这台 Mac。内容端到端加密，relay 只转发、看不到。点图上的节点看它的设置。",
  },
  { id: "about", name: "关于", icon: <Info size={16} />, lead: "版本与日志。" },
];

/** The appearance choices, in the order the control shows them. */
const APPEARANCES: readonly { readonly appearance: Appearance; readonly name: string; readonly icon: ReactNode }[] = [
  { appearance: "system", name: "跟随系统", icon: <Monitor size={15} /> },
  { appearance: "light", name: "浅色", icon: <Sun size={15} /> },
  { appearance: "dark", name: "深色", icon: <Moon size={15} /> },
];

/**
 * The settings: a window over the workbench, parts on the left and the one chosen on the right.
 *
 * @remarks
 * SPEC-0001 ("设置"): the workbench behind dims; Escape, the close button or a click outside the
 * window closes it, back to where the user was. The pi part carries a blue dot while a newer pi is
 * out. Takes the focus when it opens, so Escape reaches it.
 *
 * @sideEffects Watches remote state for this window's whole lifetime, clearing it on unmount;
 * subscribes to setup; listens for Escape and moves focus; sections send their commands.
 * @param props - The client, the part shown, what choosing a part and closing do, how to open an
 * address, and how to show a path in the Finder (none outside the desktop app).
 * @returns The panel.
 */
export function SettingsPanel({
  client,
  section,
  onSection,
  onClose,
  openUrl,
  reveal,
}: {
  readonly client: AtriumClient;
  readonly section: SettingsSection;
  readonly onSection: (section: SettingsSection) => void;
  readonly onClose: () => void;
  readonly openUrl: (url: string) => void;
  readonly reveal: ((path: string) => void) | undefined;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  /**
   * Reads remote state for the settings window, including an explicit retry from the Phone page.
   * @remarks The window is the sole watch owner, so category changes cannot silence its indicators.
   * @sideEffects Sends get_remote; failures land in the client's remote store.
   */
  const refreshRemote = useCallback((): void => {
    // Fire and forget: read failures land in the remote view, where the Phone page offers retry.
    void client.watchRemote(true);
  }, [client]);
  useEffect(() => {
    refreshRemote();
    return () => {
      // Fire and forget: the client clears secret state synchronously; a lost connection also removes the host watch.
      void client.watchRemote(false).catch(() => undefined);
    };
  }, [client, refreshRemote]);
  const [guard, setGuard] = useState<ConfigGuard>({ dirty: false, saving: false });
  const currentGuard = useRef(guard);
  /**
   * Publishes the editor's guard synchronously before a save can yield.
   * @remarks Same-task synthetic navigation must obey the saving lock too.
   * @sideEffects Updates the guard ref and rendered control state.
   * @param next - The latest draft protection flags.
   */
  const updateGuard = useCallback((next: ConfigGuard): void => {
    currentGuard.current = next;
    setGuard(next);
  }, []);
  const [pending, setPending] = useState<(() => void) | null>(null);
  /**
   * Routes all exits through the config draft guard.
   * @remarks Close gestures and category changes share the same protection.
   * @sideEffects Runs navigation or requests inline confirmation.
   * @param action - The navigation requested by the user.
   */
  const navigate = useCallback((action: () => void): void => {
    if (currentGuard.current.saving) return;
    if (currentGuard.current.dirty) setPending(() => action);
    else action();
  }, []);
  /**
   * Closes only after protecting any config draft.
   * @remarks Shared by scrim, keyboard and close button.
   * @sideEffects May close the panel or show confirmation.
   */
  const close = useCallback(() => navigate(onClose), [navigate, onClose]);
  const update = useStore(client.setup, (setup) => setup.state !== null && piUpdateAvailable(setup.state.pi));
  const remote = useStore(client.remote, (view) => view.state);
  const shown = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];
  useEffect(() => {
    // A pairing sheet may already have taken focus during this mount.
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, []);
  useEffect(() => {
    /**
     * Closes the settings on Escape.
     *
     * @remarks
     * A menu open inside takes its Escape first (`MenuButton`).
     *
     * @sideEffects Calls `onClose`.
     * @param event - The key event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    /**
     * Handles the settings shortcut before the workbench's toggle.
     * @remarks Capture prevents the outer toggle bypassing the draft guard; Escape still bubbles
     * so inner menus can consume it first.
     * @sideEffects Stops the shortcut and requests guarded close.
     * @param event - The keyboard event captured before the workbench.
     */
    const shortcut = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key !== ",") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("keydown", shortcut, true);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("keydown", shortcut, true);
    };
  }, [close]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div
        data-testid="settings-scrim"
        className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[8px] backdrop-saturate-[1.1]"
        onClick={close}
      />
      <div
        ref={dialog}
        role="dialog"
        aria-modal
        aria-label="设置"
        tabIndex={-1}
        className="relative grid h-[min(640px,calc(100vh-72px))] w-[min(900px,calc(100vw-80px))] grid-cols-[212px_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden rounded-[14px] bg-[var(--main)] shadow-[0_0_0_0.5px_var(--line-strong),0_30px_80px_-10px_rgba(0,0,0,0.45)] outline-none"
      >
        <nav
          aria-label="设置分类"
          className="flex flex-col bg-[var(--nav-bg)] px-2.5 pb-3 shadow-[inset_-0.5px_0_0_var(--line)]"
        >
          <div className="h-[50px]" />
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={entry.id === section ? "page" : undefined}
              disabled={guard.saving}
              onClick={() => {
                if (entry.id !== section) navigate(() => onSection(entry.id));
              }}
              className={`my-px flex h-8 w-full items-center gap-2.5 rounded-[var(--r)] px-2.5 text-left text-[length:var(--fs-meta)] ${
                entry.id === section
                  ? "bg-[var(--selected)] text-[var(--text)]"
                  : "text-[var(--text-2)] hover:bg-[var(--hover)]"
              }`}
            >
              <span className={entry.id === section ? "text-[var(--text-2)]" : "text-[var(--text-muted)]"}>
                {entry.icon}
              </span>
              <span className="flex-1">{entry.name}</span>
              {entry.id === "pi" && update ? <UpdateDot /> : null}
              {entry.id === "phone" && remote?.pairing?.state === "awaiting_confirmation" ? (
                <span role="img" aria-label="等你确认配对" className="size-1.5 rounded-full bg-[var(--attn)]" />
              ) : entry.id === "phone" && remote?.enabled && remote.relay?.error ? (
                <WarningCircle size={14} aria-label="连不上 relay" className="text-[var(--danger)]" />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-col">
          <header className="flex h-[50px] shrink-0 items-center gap-2 pr-3 pl-8">
            <h2 className="flex-1 text-[15px] font-semibold">{shown?.name}</h2>
            <span className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">Esc</span>
            <button
              type="button"
              aria-label="关闭设置"
              title="关闭（Esc）"
              disabled={guard.saving}
              onClick={close}
              className="inline-flex size-7 items-center justify-center rounded-[var(--r)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
            >
              <X size={16} />
            </button>
          </header>
          {pending === null ? null : (
            <div className="mx-8 mb-3 space-y-2 text-[length:var(--fs-sm)] text-[var(--text-2)]" role="alert">
              <p>有未保存的配置修改，放弃修改？</p>
              <div className="flex gap-2">
                <button type="button" className={BUTTON} onClick={() => setPending(null)}>
                  继续编辑
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={guard.saving}
                  onClick={() => {
                    if (currentGuard.current.saving) return;
                    setPending(null);
                    pending();
                  }}
                >
                  放弃修改
                </button>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto px-8 pt-1.5 pb-10">
            <p className="-mt-1 mb-[22px] text-[length:var(--fs-sm)] text-[var(--text-muted)]">{shown?.lead}</p>
            {section === "appearance" ? <AppearanceSection client={client} /> : null}
            {section === "accounts" ? <AccountsSection client={client} openUrl={openUrl} /> : null}
            {section === "projects" ? <ProjectsSection client={client} /> : null}
            {section === "pi" ? (
              <>
                <PiSection client={client} reveal={reveal} />
                <ProxyGroup client={client} />
                <PiConfigGroup
                  client={client}
                  onGuard={updateGuard}
                  requestNavigation={navigate}
                  pending={pending !== null}
                />
              </>
            ) : null}
            {section === "phone" ? <PhoneSection client={client} onRetryRemote={refreshRemote} /> : null}
            {section === "about" ? <AboutSection client={client} reveal={reveal} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The blue dot that says a newer pi is out.
 *
 * @remarks
 * On the sidebar's "设置" and the settings' pi part; it never interrupts (SPEC-0001, "设置 · pi").
 *
 * @sideEffects none
 * @returns The dot.
 */
export function UpdateDot() {
  return <span role="img" aria-label="pi 有新版本" className="size-1.5 shrink-0 rounded-full bg-[var(--tint)]" />;
}

/**
 * The settings' appearance: follow the system, light or dark, and whether the sidebar shows
 * "等你处理".
 *
 * @remarks
 * The first is the same preference as the sidebar's appearance button (SPEC-0001, "设置 · 外观").
 *
 * @sideEffects Subscribes to the client's list; sends `set_preferences` when changed.
 * @param props - The client.
 * @returns The section.
 */
function AppearanceSection({ client }: { readonly client: AtriumClient }) {
  const appearance = useStore(client.index, (index) => index.preferences.appearance);
  const inbox = useStore(client.index, (index) => index.preferences.inbox);
  return (
    <>
      <Group title="外观">
        <Row
          label="外观"
          detail="选“跟随系统”时随 macOS 的浅色、深色自动切换"
          controls={
            <div
              role="radiogroup"
              aria-label="外观"
              className="inline-grid grid-flow-col gap-0.5 rounded-[9px] bg-[var(--selected)] p-0.5"
            >
              {APPEARANCES.map((entry) => (
                <button
                  key={entry.appearance}
                  type="button"
                  role="radio"
                  aria-checked={entry.appearance === appearance}
                  onClick={() => {
                    // Fire and forget: the list shows it at once and the host keeps it.
                    void client.setPreferences({ appearance: entry.appearance }).catch(() => undefined);
                  }}
                  className={`inline-flex h-[26px] items-center justify-center gap-1.5 rounded-[7px] px-3 text-[length:var(--fs-meta)] ${
                    entry.appearance === appearance
                      ? "bg-[var(--surface-1)] text-[var(--text)] shadow-[0_0_0_0.5px_var(--line),0_1px_3px_rgba(0,0,0,0.1)] dark:bg-[var(--surface-3)]"
                      : "text-[var(--text-muted)]"
                  }`}
                >
                  {entry.icon}
                  {entry.name}
                </button>
              ))}
            </div>
          }
        />
      </Group>
      <Group title="侧栏">
        <Row
          label="显示“等你处理”"
          detail="在侧栏底部汇总等你审批、回答、授权和出错的会话"
          controls={
            <button
              type="button"
              role="switch"
              aria-checked={inbox}
              aria-label="显示“等你处理”"
              onClick={() => {
                // Fire and forget, as above.
                void client.setPreferences({ inbox: !inbox }).catch(() => undefined);
              }}
              className={`relative h-5 w-[34px] flex-none rounded-full transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow after:transition-transform ${inbox ? "bg-[var(--tint)] after:translate-x-3.5" : "bg-[var(--line-strong)]"}`}
            />
          }
        />
      </Group>
    </>
  );
}

/**
 * The settings' about: Atrium's version, the connection to the host, pi's version, and the log folder.
 *
 * @remarks
 * SPEC-0001 ("设置 · 关于"). Atrium's version is the host's. The connection shows here rather than
 * in the main window, which mentions it only when not connected. Logs help a problem report and
 * hold no credentials or conversations (observability.md).
 *
 * @sideEffects Subscribes to the client's connection and setup; may show the log folder in the
 * Finder.
 * @param props - The client, and how to show a path in the Finder.
 * @returns The section.
 */
function AboutSection({
  client,
  reveal,
}: {
  readonly client: AtriumClient;
  readonly reveal: ((path: string) => void) | undefined;
}) {
  const connection = useStore(client.connection);
  const piVersion = useStore(client.setup, (setup) => setup.state?.pi.version ?? null);
  const version = connection.status === "connected" ? connection.hostVersion : null;
  const logDir = connection.status === "connected" ? connection.logDir : null;
  return (
    <Group footer="报告问题时附上日志文件夹里的文件。日志带链路追踪 id，不记录凭据和对话内容。">
      <div className="mx-3 flex items-center gap-3.5 pt-1 pb-[18px]">
        <span className="relative size-12 shrink-0 rounded-[13px] bg-[linear-gradient(135deg,#5e84ff,#78d6d6_58%,#ffaa78)] shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_6px_16px_-6px_rgba(94,132,255,0.55)]" />
        <div className="flex-1">
          <b className="block text-[17px] font-semibold">Atrium</b>
          <small className="block text-[length:var(--fs-sm)] text-[var(--text-muted)] tabular-nums">
            版本 {version ?? "—"}
          </small>
        </div>
        <a
          href="https://pi.dev"
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--r-pill)] pr-2.5 pl-1 text-[length:var(--fs-sm)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]"
        >
          <span className="scale-[0.6]">
            <PiMark />
          </span>
          由 <b className="font-semibold">pi</b> 驱动
        </a>
      </div>
      <Row
        compact
        label="Atrium 版本"
        controls={<span className="text-[var(--text-2)] tabular-nums">{version ?? "—"}</span>}
      />
      <Row
        compact
        label="连接"
        controls={
          <span className="text-[var(--text-2)]">
            {connection.status === "connected" ? "已连接" : describeConnection(connection)}
          </span>
        }
      />
      <Row
        compact
        label="pi 版本"
        controls={
          <span className="text-[var(--text-2)] tabular-nums">{piVersion === null ? "—" : `pi ${piVersion}`}</span>
        }
      />
      <Row
        compact
        label="日志文件夹"
        controls={
          <>
            <span className="font-mono text-[length:var(--fs-sm)] text-[var(--text-2)]">{logDir ?? "—"}</span>
            {logDir === null || reveal === undefined ? null : (
              <button type="button" className={BUTTON} onClick={() => reveal(logDir)}>
                在访达中显示
              </button>
            )}
          </>
        }
      />
    </Group>
  );
}
