import { readFileSync } from "node:fs";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { DARK_COLORS, LIGHT_COLORS } from "../desktop/src/appearance/themes.js";
import { docsRoute, readDocsIndex } from "./scripts/guide.js";
import {
  CHANGELOG_ROUTE,
  DOCS_ROUTE,
  DOWNLOAD_ROUTE,
  MEDIA_ROUTE,
  REPOSITORY_URL,
  SITE_DESCRIPTION,
  SITE_TITLE,
} from "./scripts/site.js";
import { codeThemes } from "./scripts/tokens.js";

const README = new URL("../../README.md", import.meta.url);
const docsGroups = readDocsIndex(readFileSync(README, "utf8"));

export default defineConfig({
  site: process.env.TABLE_CRAFT_WEBSITE_URL,
  integrations: [
    starlight({
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      logo: { src: "./src/generated/logo.png", alt: SITE_TITLE },
      favicon: "/icons/icon-32.png",
      head: [{ tag: "link", attrs: { rel: "apple-touch-icon", href: "/icons/icon-180.png" } }],
      social: [{ icon: "github", label: "GitHub", href: REPOSITORY_URL }],
      customCss: ["./src/generated/tokens.css", "./src/styles/site.css"],
      expressiveCode: {
        themes: codeThemes(DARK_COLORS, LIGHT_COLORS),
        styleOverrides: { borderRadius: "var(--tc-radius-popover)", codeFontFamily: "var(--tc-font-mono)" },
      },
      components: { Header: "./src/components/Header.astro", Hero: "./src/components/Hero.astro" },
      sidebar: [
        { label: "Overview", link: DOCS_ROUTE },
        ...docsGroups.map((group) => ({
          label: group.label,
          items: group.pages.map((page) => ({ label: page.label, link: docsRoute(page.slug) })),
        })),
      ],
      plugins: [
        starlightLinksValidator({
          exclude: [DOWNLOAD_ROUTE, CHANGELOG_ROUTE, `${MEDIA_ROUTE}**`],
        }),
      ],
    }),
  ],
});
