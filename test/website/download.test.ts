import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPlatform } from "../../packages/website/scripts/platform.js";
import { DOWNLOADS } from "../../packages/website/scripts/site.js";

const ROOT = join(import.meta.dirname, "..", "..");
const RELEASE_DOWNLOAD_URL = /https:\/\/github\.com\/[^)\s]+\/releases\/latest\/download\/[^)\s]+/g;

describe("the website's downloads", () => {
  it("givenMacUserAgent_whenDetectingPlatform_thenItIsMacOS", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        "MacIntel",
      ),
    ).toBe("macos");
  });

  it("givenWindowsUserAgent_whenDetectingPlatform_thenItIsWindows", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
        "Win32",
      ),
    ).toBe("windows");
  });

  it("givenLinuxUserAgent_whenDetectingPlatform_thenItIsLinux", () => {
    expect(
      detectPlatform("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Linux x86_64"),
    ).toBe("linux");
  });

  it("givenUserAgentAndPlatformDisagree_whenDetectingPlatform_thenTheUserAgentWins", () => {
    expect(
      detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36", "MacIntel"),
    ).toBe("linux");
    expect(detectPlatform("Mozilla/5.0", "Win32")).toBe("windows");
  });

  it("givenDarwinUserAgent_whenDetectingPlatform_thenItIsNotWindows", () => {
    expect(detectPlatform("CFNetwork/1568 Darwin/24.0.0", "MacIntel")).toBe("macos");
  });

  it("givenPhoneOrUnknownUserAgent_whenDetectingPlatform_thenThereIsNone", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        "iPhone",
      ),
    ).toBeUndefined();
    expect(
      detectPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile", "Linux armv8l"),
    ).toBeUndefined();
    expect(detectPlatform("curl/8.7.1", "")).toBeUndefined();
  });

  it("givenSiteDownloads_whenComparedWithTheReadme_thenUrlsMatch", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const urls = DOWNLOADS.map((download) => download.url);

    expect(urls).toEqual([...readme.matchAll(RELEASE_DOWNLOAD_URL)].map((match) => match[0]));
  });
});
