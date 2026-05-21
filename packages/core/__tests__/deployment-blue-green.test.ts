import { describe, expect, it } from "bun:test";
import {
  type BlueGreenConfig,
  BlueGreenDeployer,
  type HttpFetcher,
  type NginxReloader,
  type ProcessHandle,
  type ProcessLauncher,
} from "../src/deployment/blue-green-deployer";

// ── Test helpers ───────────────────────────────────────────────────────────────────

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const APP_CMD = ["bun", "run", "start"];
const APP_CWD = "/app";
const PORT_A = 3000;
const PORT_B = 3001;

function makeHandle(pid = 1): { handle: ProcessHandle; killed: boolean } {
  const state = { handle: null as unknown as ProcessHandle, killed: false };
  state.handle = {
    pid,
    kill: async () => {
      state.killed = true;
    },
  };
  return state;
}

function makeLauncher(
  handles: ProcessHandle[],
  shouldThrow?: string,
): {
  launcher: ProcessLauncher;
  calls: Array<{ command: string[]; env?: Record<string, string> }>;
} {
  let idx = 0;
  const calls: Array<{ command: string[]; env?: Record<string, string> }> = [];
  const launcher: ProcessLauncher = async (command, _cwd, env) => {
    calls.push({ command, env });
    if (shouldThrow) throw new Error(shouldThrow);
    const h = handles[idx++];
    if (!h) throw new Error("No more handles in test launcher");
    return h;
  };
  return { launcher, calls };
}

function makeHealthy(): HttpFetcher {
  return async () => ({ status: 200, ok: true });
}

function makeUnhealthy(): HttpFetcher {
  return async () => ({ status: 503, ok: false });
}

/** Returns healthy only after `failCount` failures */
function makeHealthyAfter(failCount: number): HttpFetcher {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= failCount) return { status: 503, ok: false };
    return { status: 200, ok: true };
  };
}

function makeNginxReloader(shouldThrow?: string): {
  reloader: NginxReloader;
  calls: number[];
} {
  const calls: number[] = [];
  const reloader: NginxReloader = async (port) => {
    calls.push(port);
    if (shouldThrow) throw new Error(shouldThrow);
  };
  return { reloader, calls };
}

function baseConfig(
  overrides: Partial<BlueGreenConfig> & { nginxReloader: NginxReloader },
): BlueGreenConfig {
  return {
    appCommand: APP_CMD,
    appCwd: APP_CWD,
    portA: PORT_A,
    portB: PORT_B,
    healthCheckIntervalMs: 0,
    gracefulShutdownWaitMs: 0,
    logger: silentLogger,
    ...overrides,
  };
}

// ── Constructor ───────────────────────────────────────────────────────────────────

describe("BlueGreenDeployer — constructor", () => {
  it("defaults to portA as active, portB as standby", () => {
    const { reloader } = makeNginxReloader();
    const d = new BlueGreenDeployer(baseConfig({ nginxReloader: reloader }));
    expect(d.activePort).toBe(PORT_A);
    expect(d.standbyPort).toBe(PORT_B);
  });

  it("accepts initialActivePort = portB", () => {
    const { reloader } = makeNginxReloader();
    const d = new BlueGreenDeployer(
      baseConfig({ nginxReloader: reloader, initialActivePort: PORT_B }),
    );
    expect(d.activePort).toBe(PORT_B);
    expect(d.standbyPort).toBe(PORT_A);
  });

  it("throws when portA === portB", () => {
    const { reloader } = makeNginxReloader();
    expect(
      () =>
        new BlueGreenDeployer(baseConfig({ nginxReloader: reloader, portA: 3000, portB: 3000 })),
    ).toThrow("portA and portB must be different");
  });

  it("throws when initialActivePort is not portA or portB", () => {
    const { reloader } = makeNginxReloader();
    expect(
      () => new BlueGreenDeployer(baseConfig({ nginxReloader: reloader, initialActivePort: 9999 })),
    ).toThrow("initialActivePort must be portA");
  });

  it("throws when appCommand is empty", () => {
    const { reloader } = makeNginxReloader();
    expect(
      () => new BlueGreenDeployer(baseConfig({ nginxReloader: reloader, appCommand: [] })),
    ).toThrow("appCommand cannot be empty");
  });
});

// ── deploy() — success paths ─────────────────────────────────────────────────────

describe("BlueGreenDeployer — deploy() success", () => {
  it("returns success, updates activePort and standbyPort", async () => {
    const h1 = makeHandle(101);
    const { launcher } = makeLauncher([h1.handle]);
    const { reloader, calls: nginxCalls } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
      }),
    );

    const result = await d.deploy();

    expect(result.success).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.activePort).toBe(PORT_B);
    expect(d.activePort).toBe(PORT_B);
    expect(d.standbyPort).toBe(PORT_A);
    expect(nginxCalls).toEqual([PORT_B]);
  });

  it("passes PORT env var set to standby port", async () => {
    const h1 = makeHandle(102);
    const { launcher, calls } = makeLauncher([h1.handle]);
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
        instanceEnv: { NODE_ENV: "production" },
      }),
    );

    await d.deploy();

    expect(calls[0].env?.PORT).toBe(String(PORT_B));
    expect(calls[0].env?.NODE_ENV).toBe("production");
  });

  it("does not kill old instance on first deploy (no tracked handle)", async () => {
    const h1 = makeHandle(103);
    const { launcher } = makeLauncher([h1.handle]);
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
      }),
    );

    await d.deploy();
    expect(h1.killed).toBe(false);
  });

  it("kills old instance on second deploy after drain wait", async () => {
    const h1 = makeHandle(201);
    const h2 = makeHandle(202);
    const { launcher } = makeLauncher([h1.handle, h2.handle]);
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
        gracefulShutdownWaitMs: 0,
      }),
    );

    // First deploy: A→B active, prevHandle=h1 not killed (no prev)
    await d.deploy();
    expect(h1.killed).toBe(false);

    // Second deploy: B→A active, should kill h1 (the previous active)
    await d.deploy();
    expect(h1.killed).toBe(true);
    expect(h2.killed).toBe(false);
    expect(d.activePort).toBe(PORT_A);
    expect(d.standbyPort).toBe(PORT_B);
  });

  it("returns correct durationMs (≥ 0)", async () => {
    const h = makeHandle(104);
    const { launcher } = makeLauncher([h.handle]);
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
      }),
    );

    const result = await d.deploy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes health check after initial failures then succeeds", async () => {
    const h = makeHandle(105);
    const { launcher } = makeLauncher([h.handle]);
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthyAfter(2),
        healthCheckMaxRetries: 5,
        healthCheckIntervalMs: 0,
      }),
    );

    const result = await d.deploy();
    expect(result.success).toBe(true);
    expect(d.activePort).toBe(PORT_B);
  });

  it("health check URL uses custom healthCheckPath", async () => {
    const h = makeHandle(106);
    const { launcher } = makeLauncher([h.handle]);
    const { reloader } = makeNginxReloader();
    const checkedUrls: string[] = [];

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: async (url) => {
          checkedUrls.push(url);
          return { status: 200, ok: true };
        },
        healthCheckPath: "/api/health",
      }),
    );

    await d.deploy();
    expect(checkedUrls[0]).toBe(`http://127.0.0.1:${PORT_B}/api/health`);
  });
});

// ── deploy() — failure paths ─────────────────────────────────────────────────────

describe("BlueGreenDeployer — deploy() failures", () => {
  it("returns failure when processLauncher throws", async () => {
    const { launcher } = makeLauncher([], "spawn error");
    const { reloader, calls: nginxCalls } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
      }),
    );

    const result = await d.deploy();

    expect(result.success).toBe(false);
    expect(result.error).toContain("spawn error");
    expect(nginxCalls).toHaveLength(0);
    expect(d.activePort).toBe(PORT_A);
  });

  it("returns failure and kills standby when health checks all fail", async () => {
    const h = makeHandle(301);
    const { launcher } = makeLauncher([h.handle]);
    const { reloader, calls: nginxCalls } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeUnhealthy(),
        healthCheckMaxRetries: 3,
        healthCheckIntervalMs: 0,
      }),
    );

    const result = await d.deploy();

    expect(result.success).toBe(false);
    expect(result.error).toContain("failed health checks after 3 retries");
    expect(h.killed).toBe(true);
    expect(nginxCalls).toHaveLength(0);
    expect(d.activePort).toBe(PORT_A);
  });

  it("returns failure and kills standby when health check throws repeatedly", async () => {
    const h = makeHandle(302);
    const { launcher } = makeLauncher([h.handle]);
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: async () => {
          throw new Error("connection refused");
        },
        healthCheckMaxRetries: 2,
        healthCheckIntervalMs: 0,
      }),
    );

    const result = await d.deploy();

    expect(result.success).toBe(false);
    expect(h.killed).toBe(true);
    expect(d.activePort).toBe(PORT_A);
  });

  it("returns failure and kills standby when nginx reload throws", async () => {
    const h = makeHandle(303);
    const { launcher } = makeLauncher([h.handle]);
    const { reloader, calls: nginxCalls } = makeNginxReloader("nginx: configuration error");

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
      }),
    );

    const result = await d.deploy();

    expect(result.success).toBe(false);
    expect(result.error).toContain("nginx: configuration error");
    expect(h.killed).toBe(true);
    expect(nginxCalls).toHaveLength(1);
    // Active port should be unchanged
    expect(d.activePort).toBe(PORT_A);
  });

  it("does not change activePort on failure", async () => {
    const { launcher } = makeLauncher([], "fatal error");
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
        initialActivePort: PORT_B,
      }),
    );

    await d.deploy();
    expect(d.activePort).toBe(PORT_B);
    expect(d.standbyPort).toBe(PORT_A);
  });
});

// ── rollback() ───────────────────────────────────────────────────────────────────────

describe("BlueGreenDeployer — rollback()", () => {
  it("switches nginx to standby port and swaps active/standby", async () => {
    const { reloader, calls: nginxCalls } = makeNginxReloader();

    const d = new BlueGreenDeployer(baseConfig({ nginxReloader: reloader }));
    // active=A, standby=B — rollback should switch to B
    const result = await d.rollback();

    expect(result.success).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.activePort).toBe(PORT_B);
    expect(d.activePort).toBe(PORT_B);
    expect(d.standbyPort).toBe(PORT_A);
    expect(nginxCalls).toEqual([PORT_B]);
  });

  it("kills the recently deployed instance on rollback", async () => {
    const h = makeHandle(401);
    const { launcher } = makeLauncher([h.handle]);
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
      }),
    );

    await d.deploy(); // deploys to B; activeHandle = h
    expect(h.killed).toBe(false);

    await d.rollback(); // rolls back to A; should kill h (the B instance)
    expect(h.killed).toBe(true);
    expect(d.activePort).toBe(PORT_A);
  });

  it("returns failure when nginx reload throws during rollback", async () => {
    const { reloader, calls: nginxCalls } = makeNginxReloader("nginx error");

    const d = new BlueGreenDeployer(baseConfig({ nginxReloader: reloader }));

    const result = await d.rollback();

    expect(result.success).toBe(false);
    expect(result.phase).toBe("rolling-back");
    expect(result.error).toContain("nginx error");
    // Port should be unchanged
    expect(d.activePort).toBe(PORT_A);
    expect(nginxCalls).toHaveLength(1);
  });

  it("rollback does not kill any instance when no deploy has run", async () => {
    const { reloader } = makeNginxReloader();

    const d = new BlueGreenDeployer(baseConfig({ nginxReloader: reloader }));

    // No exception — just swaps ports via nginx
    const result = await d.rollback();
    expect(result.success).toBe(true);
    expect(d.activePort).toBe(PORT_B);
  });
});

// ── Nginx reloader integration ──────────────────────────────────────────────────────────

describe("BlueGreenDeployer — nginx reloader", () => {
  it("nginx reloader receives the standby port during deploy", async () => {
    const h = makeHandle(501);
    const { launcher } = makeLauncher([h.handle]);
    const receivedPorts: number[] = [];
    const reloader: NginxReloader = async (port) => {
      receivedPorts.push(port);
    };

    const d = new BlueGreenDeployer(
      baseConfig({
        nginxReloader: reloader,
        processLauncher: launcher,
        httpFetcher: makeHealthy(),
        initialActivePort: PORT_B,
      }),
    );

    await d.deploy(); // active=B → standby=A → deploy to A
    expect(receivedPorts).toEqual([PORT_A]);
  });
});
