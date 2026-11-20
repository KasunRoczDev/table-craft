import { app, BrowserWindow } from "electron";
import { createLaunchFiles, launchPathsOf } from "@table-craft/desktop/main/launchFiles.js";
import { CHANNELS } from "@table-craft/desktop/preload/bridge.js";

/** The files the OS asks TableCraft to open, from every way it asks (plan 163). */
export interface OpenFromOs {
  /** Hands over what is held to the window that asks; later files are pushed to it. */
  take(): readonly string[];
  /** Holds the files this process was launched with until the window takes them. */
  launchedWith(argv: readonly string[], cwd: string): Promise<void>;
  /** A window started loading; files are held until it takes them. */
  rendererLoading(): void;
  /** From now on a file that finds no window opens one. */
  windowsReady(open: () => void): void;
}

function launchPaths(argv: readonly string[], cwd: string): Promise<readonly string[]> {
  return launchPathsOf(argv, { defaultApp: process.defaultApp === true, cwd });
}

function focus(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.focus();
}

/**
 * Listens before `ready`: macOS sends a cold start's Finder Open With as `open-file` before it, and
 * the files of a second launch on Windows and Linux come as `second-instance`.
 */
export function installOpenFromOs(target: () => BrowserWindow | null): OpenFromOs {
  let openWindow: (() => void) | null = null;
  const files = createLaunchFiles((paths) => {
    const window = target();
    if (window === null) return false;
    window.webContents.send(CHANNELS.openLaunchedFiles, paths);
    focus(window);
    return true;
  });
  const arrive = (paths: readonly string[]) => {
    files.arrive(paths);
    if (paths.length > 0 && BrowserWindow.getAllWindows().length === 0) openWindow?.();
  };
  app.on("open-file", (event, path) => {
    event.preventDefault();
    arrive([path]);
  });
  app.on("second-instance", (_event, argv, workingDirectory) => {
    void launchPaths(argv, workingDirectory).then(arrive);
    const [window] = BrowserWindow.getAllWindows();
    if (window !== undefined) focus(window);
  });
  return {
    take: () => files.take(),
    launchedWith: async (argv, cwd) => files.arrive(await launchPaths(argv, cwd)),
    rendererLoading: () => files.rendererLoading(),
    windowsReady(open) {
      openWindow = open;
    },
  };
}
