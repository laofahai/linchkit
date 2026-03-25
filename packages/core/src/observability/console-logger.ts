import type { Logger } from "../types/logger";

/** Default logger backed by console.* methods */
export const consoleLogger: Logger = {
  debug: (msg, ctx) => console.debug(`[linch] ${msg}`, ctx ?? ""),
  info: (msg, ctx) => console.info(`[linch] ${msg}`, ctx ?? ""),
  warn: (msg, ctx) => console.warn(`[linch] ${msg}`, ctx ?? ""),
  error: (msg, ctx) => console.error(`[linch] ${msg}`, ctx ?? ""),
};
