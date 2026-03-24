/**
 * defineConfigSchema — binds a Zod schema to a config namespace
 * and returns a type-safe accessor (ConfigSchemaRef).
 */

import { type ZodObject, type ZodRawShape, z } from "zod";
import type { ConfigRegistry } from "./config-registry";

/** Type-safe reference to a config namespace with accessor */
export interface ConfigSchemaRef<T> {
  /** Config namespace name */
  readonly name: string;
  /** Zod schema used for validation */
  // biome-ignore lint/suspicious/noExplicitAny: ZodObject generic requires any for runtime-erased type container
  readonly schema: ZodObject<any>;
  /** Type-safe accessor. Use in action handlers / transport factories. */
  from(ctx: { config: ConfigRegistry }): Readonly<T>;
}

/**
 * Define a config schema bound to a namespace.
 *
 * @param name - Namespace name (e.g. 'system:server', 'cap-auth')
 * @param shape - Zod shape defining the config structure
 * @returns ConfigSchemaRef with type-safe `from(ctx)` accessor
 */
export function defineConfigSchema<T extends ZodRawShape>(
  name: string,
  shape: T,
): ConfigSchemaRef<z.infer<z.ZodObject<T>>> {
  const schema = z.object(shape).strict();

  return {
    name,
    schema,
    from(ctx: { config: ConfigRegistry }): Readonly<z.infer<typeof schema>> {
      return ctx.config.get<z.infer<typeof schema>>(name);
    },
  };
}
