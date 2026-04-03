/**
 * linch create capability <name> — Scaffold a new LinchKit capability
 *
 * Creates the standard directory structure with capability.json,
 * package.json, tsconfig.json, and src/ skeleton including example
 * schema, action, and view files.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateIdentifier } from "@linchkit/core";
import { defineCommand } from "citty";

const VALID_TYPES = ["standard", "adapter", "bridge"] as const;
const VALID_CATEGORIES = [
  "business",
  "system",
  "infrastructure",
  "integration",
  "ui",
  "utility",
  "starter",
] as const;

function capabilityJsonTemplate(name: string, type: string, category: string): string {
  return JSON.stringify(
    {
      name,
      version: "0.1.0",
      type,
      category,
      label: name,
      description: "",
      dependencies: [],
      main: "src/index.ts",
      extensions: {},
    },
    null,
    2,
  );
}

/** Convert a capability name to a valid TypeScript identifier */
export function toSafeIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Derive a simple domain name from the capability name (strip common prefixes) */
function toDomainName(name: string): string {
  return name.replace(/^cap[-_]/, "").replace(/-/g, "_");
}

function srcIndexTemplate(name: string, opts: { withExamples: boolean }): string {
  const safeId = toSafeIdentifier(name);
  const domain = toDomainName(name);
  if (!opts.withExamples) {
    return `import type { CapabilityDefinition } from "@linchkit/core";

export const ${safeId}: CapabilityDefinition = {
  name: "${name}",
  label: "${name}",
  type: "standard",
  category: "business",
  version: "0.1.0",
  schemas: [],
  actions: [],
  rules: [],
  views: [],
};
`;
  }
  return `import type { CapabilityDefinition } from "@linchkit/core";
import { ${domain}Schema } from "./schemas/${domain}";
import { create_${domain} } from "./actions/create-${domain.replace(/_/g, "-")}";
import { ${domain}ListView, ${domain}FormView } from "./views/${domain}";

export const ${safeId}: CapabilityDefinition = {
  name: "${name}",
  label: "${name}",
  type: "standard",
  category: "business",
  version: "0.1.0",
  schemas: [${domain}Schema],
  actions: [create_${domain}],
  rules: [],
  views: [${domain}ListView, ${domain}FormView],
};
`;
}

function exampleSchemaTemplate(domain: string): string {
  return `import { defineSchema } from "@linchkit/core";

export const ${domain}Schema = defineSchema({
  name: "${domain}",
  label: "${domain}",
  fields: {
    name: {
      type: "text",
      label: "Name",
      required: true,
    },
    description: {
      type: "text",
      label: "Description",
    },
  },
});
`;
}

function exampleActionTemplate(domain: string): string {
  return `import { defineAction } from "@linchkit/core";

export const create_${domain} = defineAction({
  name: "create_${domain}",
  label: "Create ${domain}",
  schema: "${domain}",
  type: "create",
  handler: async (input, ctx) => {
    return ctx.dataProvider.create("${domain}", input);
  },
});
`;
}

function exampleViewTemplate(domain: string): string {
  return `import type { ViewDefinition } from "@linchkit/core";

export const ${domain}ListView: ViewDefinition = {
  name: "${domain}_list",
  label: "${domain} List",
  schema: "${domain}",
  type: "list",
  fields: [
    { field: "name", label: "Name" },
    { field: "description", label: "Description" },
  ],
};

export const ${domain}FormView: ViewDefinition = {
  name: "${domain}_form",
  label: "${domain} Form",
  schema: "${domain}",
  type: "form",
  fields: [
    { field: "name", label: "Name" },
    { field: "description", label: "Description" },
  ],
};
`;
}

function directoryReadmeTemplate(dirName: string): string {
  return `# ${dirName}\n\nPlace your ${dirName} definitions in this directory.\nSee the LinchKit documentation for details.\n`;
}

function packageJsonTemplate(name: string): string {
  return JSON.stringify(
    {
      name: `@linchkit/${name}`,
      version: "0.1.0",
      type: "module",
      main: "src/index.ts",
      peerDependencies: {
        "@linchkit/core": "workspace:*",
      },
    },
    null,
    2,
  );
}

function tsconfigTemplate(): string {
  return JSON.stringify(
    {
      extends: "../../tsconfig.json",
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
      },
      include: ["src"],
    },
    null,
    2,
  );
}

export const createCapabilityCommand = defineCommand({
  meta: {
    name: "capability",
    description: "Scaffold a new LinchKit capability",
  },
  args: {
    name: {
      type: "positional",
      description: "Capability name (e.g. cap-inventory)",
      required: true,
    },
    type: {
      type: "string",
      description: "Capability type: standard | adapter | bridge (default: standard)",
      default: "standard",
    },
    category: {
      type: "string",
      description:
        "Capability category: business | system | infrastructure | integration | ui | utility (default: business)",
      default: "business",
    },
    dir: {
      type: "string",
      description: "Output directory (default: addons/<name>/cap-<name>)",
    },
    bare: {
      type: "boolean",
      description: "Skip generating example schema, action, and view files",
      default: false,
    },
  },
  run({ args }) {
    const name = args.name as string;
    const type = args.type as string;
    const category = args.category as string;
    const noExamples = args.bare as boolean;

    // Validate capability name — allow hyphens in the package name, but the
    // derived TypeScript identifier (hyphens → underscores) must be valid.
    const SAFE_NAME_RE = /^[a-z][a-z0-9_-]*$/;
    if (!SAFE_NAME_RE.test(name)) {
      console.error(
        `[linch] Invalid capability name "${name}". Must match: lowercase letters, digits, hyphens, underscores. Must start with a letter.`,
      );
      process.exit(1);
    }
    // Additionally validate the derived identifier used in generated TypeScript code
    const identifierCheck = validateIdentifier(toSafeIdentifier(name));
    if (!identifierCheck.valid) {
      console.error(`[linch] Invalid capability name "${name}": ${identifierCheck.error}`);
      process.exit(1);
    }

    // Validate type
    if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
      console.error(`Error: Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`);
      process.exit(1);
    }

    // Validate category
    if (!VALID_CATEGORIES.includes(category as (typeof VALID_CATEGORIES)[number])) {
      console.error(
        `Error: Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(", ")}`,
      );
      process.exit(1);
    }

    const outputDir = args.dir
      ? resolve(process.cwd(), args.dir as string)
      : resolve(process.cwd(), "addons", name, `cap-${name}`);

    if (existsSync(outputDir)) {
      console.error(`Error: Directory "${outputDir}" already exists.`);
      process.exit(1);
    }

    console.log(`Creating capability: ${name}`);

    const withExamples = !noExamples;
    const domain = toDomainName(name);

    // Create directory structure
    mkdirSync(resolve(outputDir, "src/schemas"), { recursive: true });
    mkdirSync(resolve(outputDir, "src/actions"), { recursive: true });
    mkdirSync(resolve(outputDir, "src/rules"), { recursive: true });
    mkdirSync(resolve(outputDir, "src/states"), { recursive: true });
    mkdirSync(resolve(outputDir, "src/views"), { recursive: true });

    // Write .gitkeep / README files for empty directories
    writeFileSync(resolve(outputDir, "src/rules/README.md"), directoryReadmeTemplate("rules"));
    writeFileSync(resolve(outputDir, "src/states/README.md"), directoryReadmeTemplate("states"));

    if (withExamples) {
      // Write example files
      writeFileSync(resolve(outputDir, `src/schemas/${domain}.ts`), exampleSchemaTemplate(domain));
      writeFileSync(
        resolve(outputDir, `src/actions/create-${domain.replace(/_/g, "-")}.ts`),
        exampleActionTemplate(domain),
      );
      writeFileSync(resolve(outputDir, `src/views/${domain}.ts`), exampleViewTemplate(domain));
    } else {
      // Write .gitkeep files when no examples
      writeFileSync(resolve(outputDir, "src/schemas/.gitkeep"), "");
      writeFileSync(resolve(outputDir, "src/actions/.gitkeep"), "");
      writeFileSync(resolve(outputDir, "src/views/.gitkeep"), "");
    }

    // Write template files
    writeFileSync(
      resolve(outputDir, "capability.json"),
      capabilityJsonTemplate(name, type, category),
    );
    writeFileSync(resolve(outputDir, "src/index.ts"), srcIndexTemplate(name, { withExamples }));
    writeFileSync(resolve(outputDir, "package.json"), packageJsonTemplate(name));
    writeFileSync(resolve(outputDir, "tsconfig.json"), tsconfigTemplate());

    console.log("");
    console.log("Capability created successfully!");
    console.log("");
    console.log("  Structure:");
    console.log(`  ${name}/`);
    console.log("    ├── capability.json");
    console.log("    ├── package.json");
    console.log("    ├── tsconfig.json");
    console.log("    └── src/");
    console.log("        ├── index.ts");
    console.log("        ├── schemas/");
    console.log("        ├── actions/");
    console.log("        ├── rules/");
    console.log("        ├── states/");
    console.log("        └── views/");
    console.log("");
    console.log(`  Path: ${outputDir}`);
  },
});

export const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Scaffold LinchKit components",
  },
  subCommands: {
    capability: createCapabilityCommand,
  },
});
