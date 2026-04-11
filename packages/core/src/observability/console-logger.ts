import type { Logger } from "../types/logger";
import { createPinoLogger } from "./pino-logger";

/**
 * Default logger instance backed by pino.
 *
 * Uses lazy initialization so that environment variables from .env files
 * (LOG_LEVEL, NODE_ENV) are respected even when loaded after module import.
 */
let _instance: Logger | null = null;

function getInstance(): Logger {
  if (!_instance) {
    _instance = createPinoLogger({ name: "linchkit" });
  }
  return _instance;
}

export const consoleLogger: Logger = {
  debug: (message, context) => getInstance().debug(message, context),
  info: (message, context) => getInstance().info(message, context),
  warn: (message, context) => getInstance().warn(message, context),
  error: (message, context) => getInstance().error(message, context),
};
