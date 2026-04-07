# @linchkit/cap-migration

Data migration capability for LinchKit — version compatibility checking, schema migration transforms, Drizzle DB migration runner, legacy data import (CSV/JSON), and entity field mapping.

## Installation

```bash
bun add @linchkit/cap-migration
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0
- `drizzle-orm` *

## Usage

### Version Compatibility

```ts
import { analyzeCompatibility, classifyRelease } from "@linchkit/cap-migration";

const result = analyzeCompatibility(oldEntities, newEntities);
const releaseType = classifyRelease(result); // "major" | "minor" | "patch"
```

### Run Database Migrations

```ts
import { runMigrations } from "@linchkit/cap-migration";

await runMigrations({
  migrationsFolder: "./drizzle/migrations",
  database: db,
});
```

### Import Legacy Data

```ts
import { DataImporter, CSVImportSource } from "@linchkit/cap-migration";

const source = new CSVImportSource({ filePath: "./data.csv" });
const importer = new DataImporter({ source, entity: "order", dataProvider });
const result = await importer.run();
```

### Entity Field Mapping

```ts
import { SchemaMapper } from "@linchkit/cap-migration";

const mapper = new SchemaMapper(fieldMappings);
const mapped = mapper.map(record);
```

## Links

- [Repository](https://github.com/laofahai/linchkit)
