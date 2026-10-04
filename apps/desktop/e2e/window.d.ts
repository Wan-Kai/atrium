/** The bridge the desktop preload exposes, as e2e tests see it. */
interface Window {
  atrium: { getBootstrap(): Promise<{ hostUrl: string; token: string }> };
}
