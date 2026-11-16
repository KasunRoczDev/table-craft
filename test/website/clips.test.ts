import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clipFile,
  encodeArguments,
  MEDIA_DIRECTORY,
  posterArguments,
  posterFile,
  WEBSITE_CLIPS,
} from "../../packages/website/scripts/clips.js";
import { HIGHLIGHTS } from "../../packages/website/scripts/landing.js";

const README_SCENES = join(import.meta.dirname, "..", "readme");
const SCENE_NAME = /\bscene\("([^"]+)"/g;

function recordedScenes(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(README_SCENES).filter((name) => name.endsWith(".media.test.ts"))) {
    for (const match of readFileSync(join(README_SCENES, file), "utf8").matchAll(SCENE_NAME)) names.add(match[1] ?? "");
  }
  return names;
}

describe("the website's clips", () => {
  it("givenWebsiteClips_whenComparedWithTheReadmeScenes_thenEachIsRecordedByOne", () => {
    const scenes = recordedScenes();

    expect(WEBSITE_CLIPS.filter((clip) => !scenes.has(clip))).toEqual([]);
  });

  it("givenWebsiteClips_whenLookingInTheMediaFolder_thenEachHasItsVideoAndPoster", () => {
    const missing = WEBSITE_CLIPS.flatMap((clip) => [clipFile(clip), posterFile(clip)]).filter(
      (file) => !existsSync(join(MEDIA_DIRECTORY, file)),
    );

    expect(missing).toEqual([]);
  });

  it("givenHighlights_whenTheyNameAClip_thenItIsAWebsiteClip", () => {
    const clips: readonly string[] = WEBSITE_CLIPS;
    const named = HIGHLIGHTS.flatMap((highlight) => (highlight.clip ? [highlight.clip] : []));

    expect(named.filter((clip) => !clips.includes(clip))).toEqual([]);
  });

  it("givenAClip_whenEncoding_thenItIsSilentH264ThatStartsBeforeItFinishesLoading", () => {
    const args = encodeArguments("in.mkv", "out.mp4");

    expect(args).toEqual(expect.arrayContaining(["-an", "libx264", "yuv420p", "+faststart"]));
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("givenAClip_whenTakingItsPoster_thenItIsTheLastFrame", () => {
    const args = posterArguments("in.mkv", "out.jpg");

    expect(args.slice(args.indexOf("-sseof"), args.indexOf("-sseof") + 2)).toEqual(["-sseof", "-0.2"]);
    expect(args).toEqual(expect.arrayContaining(["-frames:v", "1"]));
  });
});
