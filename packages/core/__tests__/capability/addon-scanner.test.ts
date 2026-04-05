import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanAddonsPath } from "../../src/capability/addon-scanner";

const TMP = join(import.meta.dir, "__tmp_addon_scan__");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeAddon(group: string, capName: string, capDef: string) {
  const dir = join(TMP, group, capName, "src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(TMP, group, capName, "package.json"),
    JSON.stringify({ name: `@linchkit/${capName}`, main: "src/index.ts" }),
  );
  writeFileSync(join(dir, "index.ts"), capDef);
}

describe("scanAddonsPath", () => {
  test("discovers capabilities in addon group directories", async () => {
    makeAddon(
      "test-group",
      "cap-test",
      `
      export default {
        name: "cap-test",
        label: "Test",
        type: "standard",
        category: "business",
        version: "0.1.0",
      };
    `,
    );

    const caps = await scanAddonsPath([TMP]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.name).toBe("cap-test");
  });

  test("ignores non-cap directories", async () => {
    const dir = join(TMP, "group1", "not-a-cap", "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(TMP, "group1", "not-a-cap", "package.json"),
      JSON.stringify({ name: "not-a-cap" }),
    );

    const caps = await scanAddonsPath([TMP]);
    expect(caps).toHaveLength(0);
  });

  test("scans multiple addon paths", async () => {
    const tmp2 = `${TMP}_2`;
    mkdirSync(tmp2, { recursive: true });

    makeAddon(
      "g1",
      "cap-a",
      `
      export default { name: "cap-a", label: "A", type: "standard", category: "business", version: "0.1.0" };
    `,
    );

    const dir2 = join(tmp2, "g2", "cap-b", "src");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      join(tmp2, "g2", "cap-b", "package.json"),
      JSON.stringify({ name: "@linchkit/cap-b", main: "src/index.ts" }),
    );
    writeFileSync(
      `${dir2}/index.ts`,
      `
      export default { name: "cap-b", label: "B", type: "standard", category: "business", version: "0.1.0" };
    `,
    );

    const caps = await scanAddonsPath([TMP, tmp2]);
    expect(caps).toHaveLength(2);

    rmSync(tmp2, { recursive: true, force: true });
  });

  test("returns empty for non-existent path", async () => {
    const caps = await scanAddonsPath(["/non/existent/path"]);
    expect(caps).toHaveLength(0);
  });
});
