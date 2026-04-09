# Entity Field Onchange — Server-Side Form Computation

> Status: Draft | Date: 2026-04-09
> Target milestone: M5 (types + API), M6 (frontend integration)
>
> Related specs:
> - [03 — Entity](./03_schema.md) (field definitions, `defineEntity()`)
> - [04 — Action](./04_action.md) (sole write entry, handler pipeline)
> - [13 — Views & UI](./13_view_and_ui.md) (AutoForm, field rendering)
> - [16 — CommandLayer & API](./16_command_layer_and_api.md) (REST + GraphQL endpoints)
> - [48 — Derived Properties](./48_derived_properties.md) (computed fields, store/compute strategies)

## 1. Problem

LinchKit has `derived` fields (Spec 48) for computed values that recalculate **on write** (strategy: `store`) or **on read** (strategy: `compute`). But neither mode supports **interactive pre-save computation** — the ability for the server to compute dependent field values while a user is editing a form, **before any Action is executed**.

### Scenarios that require onchange

| Scenario | Trigger field | Computed fields | Why derived doesn't work |
|----------|--------------|-----------------|-------------------------|
| Selecting a product on a purchase line | `product_id` | `unit_price`, `uom`, `description` | Requires server lookup against price table; result is a starting value the user may override |
| Selecting a department on a request | `department_id` | `budget_remaining`, `approver_id` | Requires cross-entity query; `budget_remaining` is contextual, not a stored derived |
| Changing quantity or unit price | `quantity`, `unit_price` | `subtotal` | Could use derived, but user needs instant feedback before save |
| Selecting a currency | `currency_id` | `exchange_rate`, `converted_amount` | Exchange rate depends on external lookup at form-edit time |

### Current workarounds and their problems

- **Frontend-only computation**: Works for simple math, but cannot perform server lookups, access other entities, or enforce business logic.
- **Derived fields (store)**: Triggers during Action execution — too late for form feedback. The user has already pressed "Save."
- **Derived fields (compute)**: Read-only, calculated on query. Cannot look up related records or produce editable starting values.
- **Rule (pre)**: Runs at save time inside the Action pipeline. Not interactive.

**Gap:** No mechanism for the server to compute form field values interactively during editing, returning suggestions that the user can accept or override before saving.

## 2. Design: `onchange` in Entity Definition

Onchange hooks are declared on the entity definition. Each hook specifies which field(s) trigger it, which fields it updates, and a server-side computation function.

```typescript
defineEntity({
  name: 'purchase_item',
  fields: {
    product_id: { type: 'ref', target: 'product', required: true },
    quantity: { type: 'number', required: true },
    unit_price: { type: 'number' },
    uom: { type: 'string' },
    description: { type: 'string' },
    subtotal: { type: 'number' },
  },
  onchange: {
    // When product_id changes, look up product details
    product_id: {
      updates: ['unit_price', 'uom', 'description'],
      compute: async (ctx) => ({
        unit_price: await ctx.lookup('product', ctx.value as string, 'default_price'),
        uom: await ctx.lookup('product', ctx.value as string, 'uom'),
        description: await ctx.lookup('product', ctx.value as string, 'description'),
      }),
    },
    // Multiple trigger fields use comma-separated key
    'quantity,unit_price': {
      updates: ['subtotal'],
      compute: (ctx) => ({
        subtotal: ((ctx.values.quantity as number) ?? 0) * ((ctx.values.unit_price as number) ?? 0),
      }),
    },
  },
})
```

### Key design decisions

1. **Declarative `updates` list**: The server only returns fields declared in `updates`. This prevents onchange functions from setting arbitrary fields.
2. **Comma-separated trigger keys**: `'quantity,unit_price'` means the hook fires when **either** field changes. The hook receives the full form values and can read both.
3. **Async support**: `compute` can be sync or async. Async enables server lookups, queries, and even external API calls.
4. **No side effects**: Onchange functions must be pure read-only computations. They never write to the database.

## 3. Types

### 3.1 OnchangeContext

```typescript
interface OnchangeContext {
  /** The field that triggered this onchange */
  changedField: string;

  /** New value of the changed field */
  value: unknown;

  /** All current form values (may include unsaved changes from the UI) */
  values: Record<string, unknown>;

  /** Actor performing the edit (from session/auth) */
  actor: Actor;

  /** Current tenant ID (if multi-tenant) */
  tenantId?: string;

  /**
   * Lookup a single field value from another entity record.
   * Equivalent to: SELECT <field> FROM <entity> WHERE id = <id>
   */
  lookup(entity: string, id: string, field: string): Promise<unknown>;

  /**
   * Query records from another entity with filtering.
   * Returns an array of matching records (read-only, permission-scoped).
   */
  query(
    entity: string,
    filter: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>>;
}
```

### 3.2 OnchangeResult

```typescript
interface OnchangeResult {
  /** Field values to apply to the form */
  updates: Record<string, unknown>;

  /** Optional non-blocking warnings to display to the user */
  warnings?: string[];
}
```

### 3.3 OnchangeDefinition

```typescript
interface OnchangeDefinition {
  /** Fields that this onchange will update. Only these fields may appear in the result. */
  updates: string[];

  /** Computation function. Receives context, returns partial record + optional warnings. */
  compute: (
    ctx: OnchangeContext,
  ) => OnchangeResult | Promise<OnchangeResult> | Record<string, unknown> | Promise<Record<string, unknown>>;
}
```

The `compute` function can return either:
- A plain `Record<string, unknown>` — treated as `{ updates: <the record> }`
- A full `OnchangeResult` with `updates` and optional `warnings`

### 3.4 EntityDefinition extension

```typescript
// Added to EntityDefinition
interface EntityDefinition {
  // ... existing fields ...

  /**
   * Onchange hooks for interactive form computation.
   * Keys are field names (single) or comma-separated field names (multi-trigger).
   * Values define which fields are updated and how.
   */
  onchange?: Record<string, OnchangeDefinition>;
}
```

## 4. API Design

### 4.1 REST Endpoint

```
POST /api/entities/:entityName/onchange
```

**Request body:**

```json
{
  "changedField": "product_id",
  "values": {
    "product_id": "prod_001",
    "quantity": 5,
    "unit_price": null,
    "uom": null
  }
}
```

**Response (200):**

```json
{
  "updates": {
    "unit_price": 29.99,
    "uom": "piece",
    "description": "Standard widget, blue variant"
  },
  "warnings": []
}
```

**Error responses:**

| Status | Condition |
|--------|-----------|
| 400 | `changedField` is missing or not a valid field |
| 404 | Entity not found or has no onchange for the given field |
| 403 | Actor lacks read permission on the entity |
| 429 | Rate limit exceeded |

### 4.2 GraphQL Mutation

Each entity with onchange definitions gets an auto-generated mutation:

```graphql
type Mutation {
  purchase_item_onchange(
    changedField: String!
    values: JSON!
  ): OnchangeResponse!
}

type OnchangeResponse {
  updates: JSON!
  warnings: [String!]!
}
```

The mutation name follows the pattern `<entity_name>_onchange`.

### 4.3 CommandLayer Integration

The onchange endpoint passes through the CommandLayer pipeline but with a restricted slot set:

| Slot | Active | Reason |
|------|--------|--------|
| pre | Yes | Request normalization |
| auth | Yes | Authentication required |
| exposure | Yes | Entity/field exposure checks |
| permission | Yes | Read-level permission on entity |
| tenant | Yes | Tenant scoping |
| pre-action | No | Not an Action — no pre-action hooks |
| post-action | No | Not an Action — no post-action hooks |

Onchange requires **read** permission, not write. The user hasn't saved yet.

## 5. Chained Onchange

When field A's onchange updates field B, and field B also has its own onchange, the system must cascade.

### 5.1 Algorithm

```
function evaluateOnchange(entityName, changedField, values):
  result = { updates: {}, warnings: [] }
  visited = new Set()
  queue = [changedField]

  while queue is not empty AND visited.size < MAX_CHAIN_DEPTH:
    field = queue.shift()
    if visited.has(field): continue
    visited.add(field)

    hook = findOnchangeHook(entityName, field)
    if hook is null: continue

    partial = hook.compute(buildContext(field, values))
    merge partial.updates into result.updates
    merge partial.warnings into result.warnings
    update values with partial.updates

    for each updatedField in partial.updates:
      if not visited.has(updatedField):
        queue.push(updatedField)

  return result
```

### 5.2 Depth Limit

**Maximum chain depth: 5 levels.** If the chain exceeds this limit, the system:
1. Returns whatever updates were computed so far
2. Adds a warning: `"Onchange chain depth limit reached (5). Some dependent fields may not be updated."`
3. Logs a structured warning for debugging

### 5.3 Cycle Detection

If a cycle is detected (field A → B → A), the system breaks the cycle by skipping already-visited fields. A startup-time validation also warns about potential cycles in onchange definitions.

### 5.4 Evaluation Order

When multiple onchange hooks match (e.g., the user changes `product_id` which updates `unit_price`, and `unit_price` has its own onchange):

1. The directly triggered hook runs first
2. Cascading hooks run in breadth-first order
3. If two hooks at the same level produce conflicting updates for the same field, the **later** (cascaded) result wins — it has more context
4. All warnings are accumulated

## 6. Frontend Integration

### 6.1 AutoForm Behavior

The `AutoForm` component (from `cap-adapter-ui`) integrates with onchange automatically:

1. **Detection**: AutoForm reads the entity's onchange definition from the server (via entity metadata endpoint or embedded in the GraphQL schema introspection).
2. **Trigger**: When a field with a registered onchange handler changes value:
   - For select/ref fields: trigger on selection change
   - For text/number fields: trigger on blur (not on every keystroke)
   - Debounce interval: 300ms minimum between calls for the same field
3. **Loading state**: While the onchange request is in flight:
   - Fields listed in `updates` show a subtle loading indicator (spinner overlay)
   - Those fields become temporarily read-only to prevent race conditions
4. **Apply**: On response, update the form state with returned values
5. **Warnings**: Display warnings as non-blocking toast or inline messages below the affected fields
6. **Override**: The user can manually change any auto-filled field after onchange completes. The field is never locked.

### 6.2 Client-Side Hook

For capability developers who build custom forms:

```typescript
import { useOnchange } from '@linchkit/cap-adapter-ui';

function MyCustomForm({ entity }: { entity: string }) {
  const form = useForm();
  const { trigger, loading, warnings } = useOnchange({
    entity,
    values: form.getValues(),
    onUpdate: (updates) => {
      for (const [field, value] of Object.entries(updates)) {
        form.setValue(field, value);
      }
    },
  });

  return (
    <SelectField
      name="product_id"
      onChange={(value) => {
        form.setValue('product_id', value);
        trigger('product_id');
      }}
    />
  );
}
```

### 6.3 Optimistic Updates

For pure arithmetic onchange (e.g., `subtotal = quantity * unit_price`), the entity definition can optionally include a `clientCompute` that runs immediately on the client, with the server response as authoritative fallback:

```typescript
'quantity,unit_price': {
  updates: ['subtotal'],
  compute: (ctx) => ({
    subtotal: (ctx.values.quantity ?? 0) * (ctx.values.unit_price ?? 0),
  }),
  // Optional: run on client for instant feedback
  clientCompute: (values) => ({
    subtotal: (values.quantity ?? 0) * (values.unit_price ?? 0),
  }),
},
```

`clientCompute` must be a pure synchronous function with no server dependencies. If present, AutoForm uses it immediately and skips the server call entirely for that hook.

## 7. Ontology Integration

OnchangeDefinitions are exposed via `OntologyRegistry`:

```typescript
// EntityDescriptor extension
interface EntityFieldInfo {
  // ... existing fields ...

  /** Whether this field triggers an onchange on other fields */
  triggersOnchange?: string[];  // field names that get updated

  /** Whether this field can be updated by onchange */
  updatedByOnchange?: string[];  // field names that trigger the update
}
```

This enables AI agents to:
- Understand field dependencies in form context
- Know which fields are auto-filled vs user-entered
- Suggest appropriate field edit sequences (e.g., "fill product_id first, then quantity")

## 8. Relationship to Existing Concepts

| Concept | When it runs | Purpose | Writes to DB | Interacts with user |
|---------|-------------|---------|-------------|-------------------|
| **derived (store)** | During Action execution (post-action) | Data integrity — ensures computed fields stay consistent | Yes | No |
| **derived (compute)** | On GraphQL/query read | Read-only virtual fields (e.g., age from birth_date) | No | No |
| **Rule (pre)** | During Action execution (pre-action) | Validation, gating, side effects at save time | Via Action | No |
| **onchange** | During form editing, before save | Interactive form computation, field auto-fill | No | Yes — returns values + warnings to UI |

### When to use which

| Need | Use |
|------|-----|
| Field must always be consistent after save | `derived (store)` |
| Field is purely calculated, never stored | `derived (compute)` |
| Validate or block save based on conditions | `Rule (pre)` |
| Fill form fields based on user selection, with server lookup | `onchange` |
| Simple client-side arithmetic during editing | `onchange` with `clientCompute` |

### Coexistence

A field can have both `derived` and be an `updates` target of an onchange. Example:
- `subtotal` is `derived (store)` with `type: 'expression'` for data integrity
- `subtotal` is also updated by `'quantity,unit_price'` onchange for instant form feedback

The onchange fills the form field during editing. When the user saves, the derived recalculation produces the authoritative value. They should agree, but derived is the source of truth.

## 9. Security

### 9.1 Permission Model

- Onchange runs with the **caller's permissions**, not system actor
- The `lookup` and `query` helpers respect the caller's read permissions and tenant scope
- If the caller lacks permission to read the target entity (e.g., `product`), the lookup returns `null` rather than throwing

### 9.2 Read-Only Guarantee

- Onchange functions **never write to the database**
- The `OnchangeContext` provides no write methods — only `lookup` and `query`
- The framework enforces this at the type level (no `DataProvider` write methods exposed)

### 9.3 Output Filtering

- Only fields declared in the `updates` array can be returned
- If the `compute` function returns extra fields not in `updates`, they are silently stripped
- This prevents onchange from being used as a data exfiltration channel

### 9.4 Rate Limiting

- **Frontend**: Debounce onchange calls (300ms minimum)
- **Server**: Rate limit per actor per entity: 30 calls per minute (configurable)
- **Server**: Global rate limit per entity: 300 calls per minute (configurable)
- Exceeding the rate limit returns HTTP 429

### 9.5 Timeout

- Onchange compute functions have a **2-second timeout** by default (configurable)
- If a compute function exceeds the timeout, the server returns a partial result (empty updates) with a warning

## 10. What NOT to Do

- **Don't replace `derived` fields** — onchange is for interactive form scenarios; derived is for data integrity after save.
- **Don't make onchange mandatory** — it is opt-in per entity, per field. Most simple entities need no onchange.
- **Don't run onchange during Action execution** — onchange is form-only. Actions have their own pipeline (Rules, derived recalculation).
- **Don't build a generic RPC mechanism** — onchange is specifically for form field computation. It accepts a `changedField` + `values` and returns `updates` + `warnings`. Nothing more.
- **Don't allow writes in onchange** — the compute function is read-only. Any attempt to write (if somehow bypassed) should be caught and logged.
- **Don't trigger onchange on programmatic value changes** — only user-initiated field changes in the UI trigger onchange calls. Setting values via Action or API does not invoke onchange.
- **Don't support field deletion in onchange** — onchange returns values to set. To clear a field, return `null` explicitly.

## 11. Configuration

### 11.1 Server-Side Config

```typescript
// In linchkit.config.ts
export default defineConfig({
  onchange: {
    /** Maximum chain depth for cascading onchange (default: 5) */
    maxChainDepth: 5,
    /** Default timeout per compute call in ms (default: 2000) */
    computeTimeout: 2000,
    /** Rate limit per actor per entity per minute (default: 30) */
    rateLimitPerActor: 30,
    /** Rate limit per entity per minute (default: 300) */
    rateLimitPerEntity: 300,
  },
});
```

### 11.2 Per-Hook Options

```typescript
onchange: {
  product_id: {
    updates: ['unit_price', 'uom', 'description'],
    compute: async (ctx) => { ... },
    /** Override default timeout for this specific hook (ms) */
    timeout: 5000,
    /** Debounce hint for the frontend (ms). Default: 300 */
    debounce: 500,
  },
}
```

## 12. Implementation Notes

### 12.1 OnchangeEngine

A new `OnchangeEngine` (in core) manages onchange evaluation:

- **Registration**: Parses entity definitions, builds a trigger-field → hook map
- **Evaluation**: Given `(entityName, changedField, values, actor)`, runs the matching hook(s) with chaining
- **Validation**: At startup, validates that all `updates` fields exist on the entity, warns about potential cycles

### 12.2 REST/GraphQL Endpoint Generation

`cap-adapter-server` auto-generates endpoints for entities that have `onchange` defined:

- REST: `POST /api/entities/:entityName/onchange` (added to existing entity router)
- GraphQL: `<entityName>_onchange` mutation (added to auto-generated schema)

Entities without `onchange` do not get these endpoints.

### 12.3 Frontend Metadata

The entity metadata endpoint (or GraphQL introspection) includes onchange information:

```json
{
  "name": "purchase_item",
  "fields": { ... },
  "onchange": {
    "product_id": { "updates": ["unit_price", "uom", "description"], "debounce": 300 },
    "quantity,unit_price": { "updates": ["subtotal"], "hasClientCompute": true }
  }
}
```

The `compute` function itself is never sent to the client. Only the metadata (trigger fields, update targets, debounce hints) is exposed.

## 13. Milestone

### M5 — Core + API

- [ ] `OnchangeDefinition`, `OnchangeContext`, `OnchangeResult` types in `@linchkit/core`
- [ ] `onchange` field on `EntityDefinition`
- [ ] `OnchangeEngine` — registration, evaluation, chaining, cycle detection
- [ ] REST endpoint `POST /api/entities/:entityName/onchange`
- [ ] GraphQL `<entityName>_onchange` mutation auto-generation
- [ ] CommandLayer integration (auth + permission + tenant slots)
- [ ] Rate limiting and timeout enforcement
- [ ] Startup-time validation (updates fields exist, cycle warnings)
- [ ] Unit tests for OnchangeEngine (chaining, depth limit, cycle handling)

### M6 — Frontend Integration

- [ ] AutoForm automatic onchange detection and triggering
- [ ] Loading state on dependent fields during computation
- [ ] Warning display (toast/inline)
- [ ] `useOnchange` hook for custom forms
- [ ] `clientCompute` optimistic update support
- [ ] Ontology integration (field dependency metadata)
- [ ] E2E test: product selection → price auto-fill → quantity change → subtotal update
