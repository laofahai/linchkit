import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityDefinition } from "@linchkit/core";
import { generateCapabilityStylesheet } from "../src/utils/generate-capability-styles";

describe("generateCapabilityStylesheet", () => {
  it("generates capability imports in config order after ui-kit base styles", () => {
    const root = mkdtempSync(join(tmpdir(), "linchkit-cap-styles-"));
    const uiPackageDir = join(root, "addons/adapter-ui-react/cap-adapter-ui-react");
    const uiSrcDir = join(uiPackageDir, "src");

    mkdirSync(uiSrcDir, { recursive: true });
    writeFileSync(join(uiPackageDir, "package.json"), "{}");

    const capabilities: CapabilityDefinition[] = [
      {
        name: "cap-auth",
        label: "Auth",
        type: "standard",
        category: "system",
        version: "0.0.1",
        ui: { styles: ["@linchkit/cap-auth/styles.css"] },
      },
      {
        name: "cap-theme",
        label: "Theme",
        type: "standard",
        category: "system",
        version: "0.0.1",
        ui: { styles: ["@linchkit/cap-theme/styles.css"] },
      },
    ];

    const result = generateCapabilityStylesheet(capabilities, root);

    expect(result).not.toBeNull();
    expect(existsSync(join(uiSrcDir, "capability-styles.css"))).toBe(true);

    const content = readFileSync(join(uiSrcDir, "capability-styles.css"), "utf8");
    expect(content).toContain('@import "@linchkit/ui-kit/styles.css";');
    expect(content).toContain('@import "@linchkit/cap-auth/styles.css";');
    expect(content).toContain('@import "@linchkit/cap-theme/styles.css";');
    expect(content.indexOf('@import "@linchkit/cap-auth/styles.css";')).toBeLessThan(
      content.indexOf('@import "@linchkit/cap-theme/styles.css";'),
    );
  });
});
