/**
 * Translation management REST endpoints.
 *
 * Provides CRUD for per-record translatable field values:
 * - GET    /api/entities/:name/:id/translations           — all translations
 * - PUT    /api/entities/:name/:id/translations/:locale   — set/update locale
 * - DELETE /api/entities/:name/:id/translations/:locale   — remove locale
 */

import { getTranslatableFields } from "@linchkit/core";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { badRequest, notFound, resolveActor, serviceUnavailable } from "./shared";

export function mountTranslationRoutes(app: Elysia, options: ServerOptions): void {
  const { entityRegistry, commandLayer, dataProvider } = options;

  // GET /api/entities/:name/:id/translations
  app.get("/api/entities/:name/:id/translations", async ({ params, set }) => {
    if (!entityRegistry || !dataProvider) {
      return serviceUnavailable(set, "Entity registry or data provider not configured.");
    }

    const schema = entityRegistry.get(params.name);
    if (!schema) {
      return notFound(set, `Entity "${params.name}" not found.`);
    }

    const translatableFields = getTranslatableFields(schema);
    if (translatableFields.size === 0) {
      return { success: true, data: {} };
    }

    // Read the record (raw, without locale resolution)
    const record = await dataProvider.get(params.name, params.id);
    if (!record) {
      return notFound(set, `Record "${params.id}" not found.`);
    }

    // Extract translatable field values (locale maps)
    const translations: Record<string, Record<string, string>> = {};
    for (const fieldName of translatableFields) {
      const val = record[fieldName];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        translations[fieldName] = val as Record<string, string>;
      } else if (typeof val === "string") {
        // Plain string — wrap under default locale
        const defaultLocale = schema.i18n?.defaultLocale ?? "en";
        translations[fieldName] = { [defaultLocale]: val };
      } else {
        translations[fieldName] = {};
      }
    }

    return { success: true, data: translations };
  });

  // PUT /api/entities/:name/:id/translations/:locale
  app.put(
    "/api/entities/:name/:id/translations/:locale",
    async ({ params, body, set, request }) => {
      if (!entityRegistry || !commandLayer) {
        return serviceUnavailable(set, "Entity registry or command layer not configured.");
      }

      const schema = entityRegistry.get(params.name);
      if (!schema) {
        return notFound(set, `Entity "${params.name}" not found.`);
      }

      const translatableFields = getTranslatableFields(schema);
      if (translatableFields.size === 0) {
        return badRequest(set, `Entity "${params.name}" has no translatable fields.`);
      }

      // Body should be { fieldName: "translated value", ... }
      const translations = body as Record<string, string>;
      if (!translations || typeof translations !== "object") {
        return badRequest(set, "Request body must be an object of { fieldName: translatedValue }.");
      }

      // Validate that all provided fields are translatable
      for (const key of Object.keys(translations)) {
        if (!translatableFields.has(key)) {
          return badRequest(set, `Field "${key}" is not translatable.`);
        }
      }

      // Read current record to merge translations
      let record: Record<string, unknown> | null = null;
      if (dataProvider) {
        record = await dataProvider.get(params.name, params.id);
      }
      if (!record) {
        return notFound(set, `Record "${params.id}" not found.`);
      }

      // Build update payload: merge new locale into existing locale maps
      const updatePayload: Record<string, unknown> = {};
      for (const [fieldName, translation] of Object.entries(translations)) {
        const existing = record[fieldName];
        const localeMap =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? { ...(existing as Record<string, string>) }
            : {};
        localeMap[params.locale] = translation;
        updatePayload[fieldName] = localeMap;
      }

      // Execute update via command layer
      const actor = await resolveActor(request, options.resolveRequestActor);
      const result = await commandLayer.execute({
        command: `${params.name}.update`,
        input: { id: params.id, ...updatePayload },
        actor,
      });

      if (!result.success) {
        set.status = 422;
        return result;
      }

      return { success: true, data: updatePayload };
    },
  );

  // DELETE /api/entities/:name/:id/translations/:locale
  app.delete("/api/entities/:name/:id/translations/:locale", async ({ params, set, request }) => {
    if (!entityRegistry || !commandLayer || !dataProvider) {
      return serviceUnavailable(
        set,
        "Entity registry, command layer, or data provider not configured.",
      );
    }

    const schema = entityRegistry.get(params.name);
    if (!schema) {
      return notFound(set, `Entity "${params.name}" not found.`);
    }

    const translatableFields = getTranslatableFields(schema);
    if (translatableFields.size === 0) {
      return badRequest(set, `Entity "${params.name}" has no translatable fields.`);
    }

    const record = await dataProvider.get(params.name, params.id);
    if (!record) {
      return notFound(set, `Record "${params.id}" not found.`);
    }

    // Remove the locale from all translatable fields
    const updatePayload: Record<string, unknown> = {};
    let changed = false;
    for (const fieldName of translatableFields) {
      const existing = record[fieldName];
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        const localeMap = { ...(existing as Record<string, string>) };
        if (params.locale in localeMap) {
          delete localeMap[params.locale];
          updatePayload[fieldName] = localeMap;
          changed = true;
        }
      }
    }

    if (!changed) {
      return { success: true, data: { message: "No translations found for this locale." } };
    }

    const actor = await resolveActor(request, options.resolveRequestActor);
    const result = await commandLayer.execute({
      command: `${params.name}.update`,
      input: { id: params.id, ...updatePayload },
      actor,
    });

    if (!result.success) {
      set.status = 422;
      return result;
    }

    return { success: true, data: { removed: params.locale } };
  });
}
