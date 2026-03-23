import type { Logger } from "../types/logger";

/** Default logger backed by console.* methods */
export const consoleLogger: Logger = {
  debug: (msg, ctx) => console.debug(`[linchkit] ${msg}`, ctx ?? ""),
  info: (msg, ctx) => console.info(`[linchkit] ${msg}`, ctx ?? ""),
  warn: (msg, ctx) => console.warn(`[linchkit] ${msg}`, ctx ?? ""),
  error: (msg, ctx) => console.error(`[linchkit] ${msg}`, ctx ?? ""),
};
