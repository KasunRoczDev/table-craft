import { resolve } from "node:path";

export const MEDIA_DIRECTORY = resolve(import.meta.dirname, "../media");

/** README media scenes (`test/readme/*.media.test.ts`) the landing page plays as video. */
export const WEBSITE_CLIPS = [
  "how-it-works",
  "completion",
  "grid",
  "table-editor",
  "explain",
  "diagram",
  "search-everywhere",
  "themes",
] as const;
export type WebsiteClip = (typeof WEBSITE_CLIPS)[number];

export const CLIP_WIDTH_PX = 1600;
const CLIP_FPS = 30;
/** CRF 28 keeps a 12-second scene near 160 KB with the console's text still crisp at 1600 px. */
const CLIP_CRF = 28;
const POSTER_QUALITY = 3;

export const clipFile = (clip: string): string => `${clip}.mp4`;
export const posterFile = (clip: string): string => `${clip}.jpg`;

export function encodeArguments(input: string, output: string): string[] {
  return [
    "-y",
    "-v",
    "error",
    "-i",
    input,
    "-an",
    "-vf",
    `fps=${String(CLIP_FPS)},scale=${String(CLIP_WIDTH_PX)}:-2:flags=lanczos`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(CLIP_CRF),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ];
}

export function posterArguments(input: string, output: string): string[] {
  return [
    "-y",
    "-v",
    "error",
    "-sseof",
    "-0.2",
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${String(CLIP_WIDTH_PX)}:-2:flags=lanczos`,
    "-q:v",
    String(POSTER_QUALITY),
    "-update",
    "1",
    output,
  ];
}
