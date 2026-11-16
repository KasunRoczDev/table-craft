import type { Platform } from "./site.js";

const MOBILE = /android|iphone|ipad|ipod|cros/i;
const PLATFORMS: readonly [RegExp, Platform][] = [
  [/windows|win32|win64/i, "windows"],
  [/mac/i, "macos"],
  [/linux|x11/i, "linux"],
];

function platformIn(text: string): Platform | undefined {
  return PLATFORMS.find(([pattern]) => pattern.test(text))?.[1];
}

/**
 * The desktop platform a browser runs on; phones get none. The user agent decides, and
 * `navigator.platform` only when the user agent names none, since a browser that overrides its user
 * agent keeps reporting the real platform.
 */
export function detectPlatform(userAgent: string, platform: string): Platform | undefined {
  if (MOBILE.test(userAgent) || MOBILE.test(platform)) return undefined;
  return platformIn(userAgent) ?? platformIn(platform);
}
