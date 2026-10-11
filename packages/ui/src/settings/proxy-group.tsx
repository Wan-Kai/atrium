import { type AtriumClient, CommandError } from "@atrium/client";
import type { ProxySetting } from "@atrium/protocol";
import { useState } from "react";
import { useStore } from "zustand";
import { BUTTON, FIELD, Group, PRIMARY_BUTTON, Row, Spinner } from "./parts";

/**
 * The settings' network proxy: the address pi and the host go through, and the hosts that go direct.
 *
 * @remarks
 * SPEC-0001 ("设置 · pi"): it takes the place of the login shell's proxy for every pi started
 * after it, installing and updating, and the host's own requests; a pi running keeps what it
 * started with. The fields start from what the host keeps, again whenever that changes, as after
 * saving, when the host has written the address in one form.
 *
 * @sideEffects Subscribes to the client's list; sends `set_preferences` when saved or cleared.
 * @param props - The client.
 * @returns The group.
 */
export function ProxyGroup({ client }: { readonly client: AtriumClient }) {
  const saved = useStore(client.index, (index) => index.preferences.proxy);
  return <ProxyForm key={JSON.stringify(saved)} client={client} saved={saved} />;
}

/**
 * The proxy's fields, starting from what the host keeps.
 *
 * @remarks
 * See {@link ProxyGroup}. Hosts that go direct are split by commas or lines, and shown split by
 * commas, so a long list wraps.
 *
 * @sideEffects Sends `set_preferences` when saved or cleared.
 * @param props - The client and the proxy the host keeps.
 * @returns The group.
 */
function ProxyForm({ client, saved }: { readonly client: AtriumClient; readonly saved: ProxySetting | null }) {
  const [url, setUrl] = useState(saved?.url ?? "");
  const [hosts, setHosts] = useState(saved?.noProxy.join(", ") ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const noProxy = hosts.split(/[\s,]+/u).filter((host) => host !== "");
  const unchanged = url.trim() === (saved?.url ?? "") && noProxy.join(",") === (saved?.noProxy.join(",") ?? "");

  /**
   * Has the host keep a proxy, or none.
   *
   * @remarks
   * What the host keeps comes back through the list; a refusal is explained under the fields.
   *
   * @sideEffects Sends `set_preferences`.
   * @param proxy - The proxy, `null` for none.
   */
  const keep = (proxy: ProxySetting | null): void => {
    setSaving(true);
    setProblem(null);
    // Fire and forget: the failure is shown.
    void client.setPreferences({ proxy }).then(
      () => setSaving(false),
      (error: unknown) => {
        setSaving(false);
        setProblem(describeProxyFailure(error));
      },
    );
  };

  return (
    <Group
      title="网络代理"
      description="pi 连模型服务、登录、安装和更新，以及 Atrium 查 pi 的新版本，都走这个代理。不设时沿用终端里的 HTTPS_PROXY。"
      footer="已经在运行的会话不受影响，下次启动 pi 时用新的设置。"
    >
      <Row
        label="代理地址"
        detail={saved === null ? "没有设置" : "已设置"}
        controls={
          <input
            aria-label="代理地址"
            className={`${FIELD} w-[260px] font-mono text-[length:var(--fs-sm)]`}
            placeholder="http://127.0.0.1:7897"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        }
      />
      <Row label="不走代理的地址" detail="用逗号或换行分开；本机的地址总是直连">
        <textarea
          aria-label="不走代理的地址"
          className={`${FIELD} mt-2 h-auto w-full resize-y py-1.5 font-mono text-[length:var(--fs-sm)]`}
          placeholder=".example.com, localhost"
          rows={3}
          spellCheck={false}
          value={hosts}
          onChange={(event) => setHosts(event.target.value)}
        />
      </Row>
      <div className="mx-3 mt-2 flex items-center gap-2">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={saving || unchanged || url.trim() === ""}
          onClick={() => keep({ url: url.trim(), noProxy })}
        >
          {saving ? <Spinner /> : null}
          保存
        </button>
        {saved === null ? null : (
          <button type="button" className={BUTTON} disabled={saving} onClick={() => keep(null)}>
            不用代理
          </button>
        )}
      </div>
      {problem === null ? null : (
        <p role="alert" className="mx-3 mt-2 text-[length:var(--fs-sm)] text-[var(--danger)]">
          {problem}
        </p>
      )}
    </Group>
  );
}

/**
 * Why the proxy was not kept, in words.
 *
 * @remarks
 * The host sends codes only; the UI words them (AGENTS.md, "写代码").
 *
 * @sideEffects none
 * @param error - The failure.
 * @returns The text.
 */
function describeProxyFailure(error: unknown): string {
  if (!(error instanceof CommandError) || error.code !== "proxy_invalid") return "没保存成功，稍后再试";
  return (
    REFUSALS[String(error.params?.["reason"])] ?? "代理地址写得不对，要像 http://127.0.0.1:7897 这样，只写主机和端口"
  );
}

/** What each reason the host refuses a proxy for means; `malformed` and any other read as the default. */
const REFUSALS: Readonly<Record<string, string>> = {
  scheme: "只支持 http:// 或 https:// 开头的代理地址",
  credentials: "代理地址里不能带用户名和密码",
  no_proxy: "不走代理的地址里有写不对的一项",
};
