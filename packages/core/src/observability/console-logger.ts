import { createPinoLogger } from "./pino-logger";

/**
 * Default logger instance backed by pino.
 * Kept as `consoleLogger` export name for backward compatibility.
 */
export const consoleLogger = createPinoLogger({ name: "linchkit" });
