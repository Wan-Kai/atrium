import { fileIconName } from "./file-icons";

/**
 * The address an icon is loaded from.
 *
 * @remarks
 * The icons are static files, copied by `scripts/file-icons.mjs`; each is fetched the first time
 * it shows.
 *
 * @sideEffects none
 * @param icon - The icon's name.
 * @returns Its address.
 */
function iconUrl(icon: string): string {
  return `${import.meta.env.BASE_URL}file-icons/${icon}.svg`;
}

/**
 * A file's type icon, from material-icon-theme, in its own colours.
 *
 * @remarks
 * design-language ("消息流 · 文件胶囊"). Decoration only, as the name beside it says the type.
 * Where the light appearance has a variant of its own, both are in the page and CSS shows the one
 * that fits, so no icon has to watch the appearance.
 *
 * @sideEffects none; the browser fetches the icon.
 * @param props - The file's path or name, and the icon's size in pixels.
 * @returns The icon.
 */
export function FileIcon({ path, size }: { readonly path: string; readonly size: number }) {
  const dark = fileIconName(path, false);
  const light = fileIconName(path, true);
  const shared = { alt: "", "aria-hidden": true, width: size, height: size, draggable: false } as const;
  if (light === dark) {
    return <img {...shared} src={iconUrl(dark)} data-testid="file-icon" data-icon={dark} className="flex-none" />;
  }
  return (
    <>
      <img
        {...shared}
        src={iconUrl(light)}
        data-testid="file-icon"
        data-icon={light}
        className="flex-none dark:hidden"
      />
      <img
        {...shared}
        src={iconUrl(dark)}
        data-testid="file-icon"
        data-icon={dark}
        className="hidden flex-none dark:block"
      />
    </>
  );
}
