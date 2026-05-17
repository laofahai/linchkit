/**
 * Tests for the OTLP signal URL resolver used by `bootstrapNodeSdk`.
 *
 * Mirrors the OpenTelemetry specification for endpoint resolution:
 * per-signal env vars are verbatim, base endpoints get the signal path
 * appended via the `URL` constructor (so we never produce double
 * slashes or drop a path prefix configured on the base).
 */

import { describe, expect, it } from "bun:test";
import { resolveSignalUrl } from "../src/sdk-bootstrap";

describe("resolveSignalUrl", () => {
  it("returns the per-signal env value verbatim when set (traces)", () => {
    const url = resolveSignalUrl({
      perSignalEnv: "https://collector.example.com/custom/trace-path",
      base: "http://localhost:4318",
      signalPath: "v1/traces",
    });
    expect(url).toBe("https://collector.example.com/custom/trace-path");
  });

  it("returns the per-signal env value verbatim when set (metrics)", () => {
    const url = resolveSignalUrl({
      perSignalEnv: "https://collector.example.com/custom/metric-path",
      base: "http://localhost:4318",
      signalPath: "v1/metrics",
    });
    expect(url).toBe("https://collector.example.com/custom/metric-path");
  });

  it("treats an empty per-signal env var as unset and falls back to base", () => {
    const url = resolveSignalUrl({
      perSignalEnv: "",
      base: "http://localhost:4318",
      signalPath: "v1/traces",
    });
    expect(url).toBe("http://localhost:4318/v1/traces");
  });

  it("appends v1/traces to the base when no per-signal env is set", () => {
    const url = resolveSignalUrl({
      perSignalEnv: undefined,
      base: "http://localhost:4318",
      signalPath: "v1/traces",
    });
    expect(url).toBe("http://localhost:4318/v1/traces");
  });

  it("appends v1/metrics to the base when no per-signal env is set", () => {
    const url = resolveSignalUrl({
      perSignalEnv: undefined,
      base: "http://localhost:4318",
      signalPath: "v1/metrics",
    });
    expect(url).toBe("http://localhost:4318/v1/metrics");
  });

  it("does not double-slash when the base already has a trailing slash", () => {
    const url = resolveSignalUrl({
      perSignalEnv: undefined,
      base: "http://localhost:4318/",
      signalPath: "v1/traces",
    });
    expect(url).toBe("http://localhost:4318/v1/traces");
  });

  it("preserves a path prefix on the base endpoint", () => {
    // The OTel spec allows a base such as `https://gateway/otlp` for
    // collectors mounted behind a reverse proxy. `new URL` only
    // honours the prefix when the base ends in `/`, which the
    // resolver normalises before joining.
    const url = resolveSignalUrl({
      perSignalEnv: undefined,
      base: "https://gateway.example.com/otlp",
      signalPath: "v1/traces",
    });
    expect(url).toBe("https://gateway.example.com/otlp/v1/traces");
  });

  it("preserves a path prefix on the base endpoint (trailing slash)", () => {
    const url = resolveSignalUrl({
      perSignalEnv: undefined,
      base: "https://gateway.example.com/otlp/",
      signalPath: "v1/metrics",
    });
    expect(url).toBe("https://gateway.example.com/otlp/v1/metrics");
  });

  it("returns undefined when neither per-signal env nor base is set", () => {
    const url = resolveSignalUrl({
      perSignalEnv: undefined,
      base: undefined,
      signalPath: "v1/traces",
    });
    expect(url).toBeUndefined();
  });

  it("treats an empty base as unset and returns undefined", () => {
    const url = resolveSignalUrl({
      perSignalEnv: undefined,
      base: "",
      signalPath: "v1/traces",
    });
    expect(url).toBeUndefined();
  });
});
