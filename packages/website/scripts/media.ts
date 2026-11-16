/**
 * `bun run website:media` records the website's clips and encodes them into `packages/website/media/`:
 * an H.264 MP4 per scene and a poster of its last frame, which reduced motion and a slow network see.
 *
 *   bun run website:media                        record every clip, then encode
 *   README_MEDIA=explain bun run website:media   record only that clip, then encode them all
 *   bun run website:media -- --encode            encode the clips already recorded
 *
 * Recording runs `readme:media` with `README_MEDIA_CLIPS` (decision 036), so it needs what that needs:
 * Docker, ffmpeg and a display. A clip is the window's own pixels at 60 fps, so the site's video stays
 * sharp where the README's 256-colour GIF of the same scene would blur once shown larger.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { clipFile, encodeArguments, MEDIA_DIRECTORY, posterArguments, posterFile, WEBSITE_CLIPS } from "./clips.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLIPS = join(ROOT, "dist/website-clips");
const ENCODE_FLAG = "--encode";

class MediaError extends Error {
  override name = "MediaError";
}

function record(): void {
  const scenes = process.env["README_MEDIA"] ?? WEBSITE_CLIPS.join(",");
  const run = spawnSync("bun", ["run", "readme:media"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, README_MEDIA: scenes, README_MEDIA_CLIPS: CLIPS },
  });
  if (run.status !== 0) throw new MediaError("Recording the clips failed; see readme:media's output above.");
}

function encode(): void {
  const missing = WEBSITE_CLIPS.filter((clip) => !existsSync(join(CLIPS, `${clip}.mkv`)));
  if (missing.length > 0) {
    const names = missing.join(",");
    throw new MediaError(`No clip for ${names}; record it with README_MEDIA=${names} bun run website:media.`);
  }
  mkdirSync(MEDIA_DIRECTORY, { recursive: true });
  for (const clip of WEBSITE_CLIPS) {
    const input = join(CLIPS, `${clip}.mkv`);
    execFileSync("ffmpeg", encodeArguments(input, join(MEDIA_DIRECTORY, clipFile(clip))), { stdio: "inherit" });
    execFileSync("ffmpeg", posterArguments(input, join(MEDIA_DIRECTORY, posterFile(clip))), { stdio: "inherit" });
  }
  console.log(`website: ${String(WEBSITE_CLIPS.length)} clips in ${MEDIA_DIRECTORY}`);
}

if (!process.argv.includes(ENCODE_FLAG)) record();
encode();
