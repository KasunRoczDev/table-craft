import { describe, expect, it } from "vitest";
import { DARK_COLORS, LIGHT_COLORS } from "@table-craft/desktop/appearance/themes.js";
import { codeThemes, themeProperties, tokensCss } from "../../packages/website/scripts/tokens.js";

/** Every colour Starlight's own stylesheet reads (`@astrojs/starlight/style/props.css`). */
const STARLIGHT_COLORS = [
  "--sl-color-white",
  "--sl-color-gray-1",
  "--sl-color-gray-2",
  "--sl-color-gray-3",
  "--sl-color-gray-4",
  "--sl-color-gray-5",
  "--sl-color-gray-6",
  "--sl-color-gray-7",
  "--sl-color-black",
  "--sl-color-accent-low",
  "--sl-color-accent",
  "--sl-color-accent-high",
  "--sl-color-text-invert",
  "--sl-color-bg-nav",
  "--sl-color-bg-sidebar",
  "--sl-color-hairline",
  "--sl-color-blue",
  "--sl-color-green",
  "--sl-color-orange",
  "--sl-color-red",
  "--sl-color-purple",
];
const HEX = /#[0-9a-f]{6}\b/gi;

describe("the website's colours", () => {
  it("givenAppThemes_whenWritingTokensCss_thenEveryStarlightColourIsDerived", () => {
    for (const colors of [DARK_COLORS, LIGHT_COLORS]) {
      const properties = themeProperties(colors);
      const appColors = new Set([...JSON.stringify(colors).matchAll(HEX)].map((match) => match[0].toLowerCase()));

      for (const name of STARLIGHT_COLORS) {
        const value = properties[name];
        expect(value, name).toBeDefined();
        for (const hex of value?.match(HEX) ?? []) expect(appColors, `${name}: ${hex}`).toContain(hex.toLowerCase());
      }
      expect(properties["--sl-color-black"]).toBe(colors.canvas);
      expect(properties["--sl-color-accent"]).toBe(colors.accent);
      expect(properties["--sl-color-text-invert"]).toBe(colors.accentInk);
    }
  });

  it("givenAppThemes_whenWritingTokensCss_thenDarkIsTheDefaultAndLightFollowsTheToggle", () => {
    const css = tokensCss(DARK_COLORS, LIGHT_COLORS);

    expect(css).toMatch(new RegExp(`:root \\{[^}]*--sl-color-black: ${DARK_COLORS.canvas};[^}]*color-scheme: dark;`));
    expect(css).toMatch(
      new RegExp(
        `:root\\[data-theme="light"\\] \\{[^}]*--sl-color-black: ${LIGHT_COLORS.canvas};[^}]*color-scheme: light;`,
      ),
    );
    expect(css).toContain('--sl-font-mono: "JetBrains Mono"');
  });

  it("givenAppThemes_whenBuildingCodeThemes_thenSyntaxTokensColourTheScopes", () => {
    const [dark, light] = codeThemes(DARK_COLORS, LIGHT_COLORS);

    for (const [theme, colors] of [
      [dark, DARK_COLORS],
      [light, LIGHT_COLORS],
    ] as const) {
      const scopeColor = (scope: string) =>
        theme.tokenColors.find((rule) => rule.scope.includes(scope))?.settings.foreground;

      expect(theme.colors["editor.background"]).toBe(colors.panel);
      expect(scopeColor("keyword")).toBe(colors.syntax.keyword);
      expect(scopeColor("string")).toBe(colors.syntax.string);
      expect(scopeColor("constant.numeric")).toBe(colors.syntax.number);
      expect(scopeColor("comment")).toBe(colors.syntax.comment);
      expect(scopeColor("keyword.operator")).toBe(colors.syntax.operator);
    }
    expect([dark.type, light.type]).toEqual(["dark", "light"]);
  });
});
