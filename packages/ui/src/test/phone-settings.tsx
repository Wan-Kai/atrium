import type { AtriumClient } from "@atrium/client";
import { SettingsPanel } from "../settings/settings-panel";

/**
 * Opens Phone component scenarios inside their actual production watch owner.
 * @remarks This helper has no subscription effect; SettingsPanel owns the watch and its cleanup.
 * Isolated pairing-dialog tests continue to render that dialog directly without any watch.
 * @sideEffects Renders the real settings window, which watches remote state while mounted.
 * @param props - The scenario's client.
 * @returns The production window on its Phone category.
 */
export function PhoneSettings({ client }: { readonly client: AtriumClient }) {
  return (
    <SettingsPanel
      client={client}
      section="phone"
      onSection={() => undefined}
      onClose={() => undefined}
      openUrl={() => undefined}
      reveal={undefined}
    />
  );
}
