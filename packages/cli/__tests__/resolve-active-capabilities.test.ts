import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityDefinition, LinchKitConfig } from "@linchkit/core";
import { resolveActiveCapabilities } from "../src/utils/load-config";

const TMP = join(import.meta.dir, "__tmp_resolve_active__");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Write a bare capability package into the fixture addons tree. */
function makeAddon(group: string, capName: string, def: Record<string, unknown>) {
  const dir = join(TMP, group, capName, "src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(TMP, group, capName, "package.json"),
    JSON.stringify({ name: `@linchkit/${capName}`, main: "src/index.ts" }),
  );
  writeFileSync(join(dir, "index.ts"), `export default ${JSON.stringify(def)};`);
}

function cap(name: string, opts?: Partial<CapabilityDefinition>): CapabilityDefinition {
  return { name, label: name, type: "standard", category: "system", version: "0.1.0", ...opts };
}

describe("resolveActiveCapabilities", () => {
  test("config-with-starter + discovered cap-auth/cap-permission → expanded deduped active set", async () => {
    // FIXTURE addons dir (NOT the real ./addons): bare scanned defaults
    makeAddon("auth", "cap-auth", {
      name: "cap-auth",
      label: "Auth",
      type: "standard",
      category: "system",
      version: "1.0.0",
    });
    makeAddon("permission", "cap-permission", {
      name: "cap-permission",
      label: "Permission",
      type: "standard",
      category: "system",
      version: "1.0.0",
      dependencies: ["cap-auth"],
    });

    const config: LinchKitConfig = {
      capabilities: [cap("starter-minimal", { dependencies: ["cap-auth", "cap-permission"] })],
      addons_path: [TMP],
    };

    const active = await resolveActiveCapabilities(config);
    const names = active.map((c) => c.name);

    expect(names).toContain("starter-minimal");
    expect(names).toContain("cap-auth");
    expect(names).toContain("cap-permission");
    // deduped: each discovered dep appears exactly once
    expect(names.filter((n) => n === "cap-auth")).toHaveLength(1);
    expect(names.filter((n) => n === "cap-permission")).toHaveLength(1);
  });

  test("explicit factory-wired cap beats the bare scanned default", async () => {
    makeAddon("auth", "cap-auth", {
      name: "cap-auth",
      label: "Auth",
      type: "standard",
      category: "system",
      version: "1.0.0",
    });

    const config: LinchKitConfig = {
      capabilities: [cap("cap-auth", { version: "2.0.0" })],
      addons_path: [TMP],
    };

    const active = await resolveActiveCapabilities(config);
    const auth = active.filter((c) => c.name === "cap-auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]?.version).toBe("2.0.0");
  });

  test("returns explicit-only set when no addons_path configured", async () => {
    const config: LinchKitConfig = { capabilities: [cap("A")] };
    const active = await resolveActiveCapabilities(config);
    expect(active.map((c) => c.name)).toEqual(["A"]);
  });
});
