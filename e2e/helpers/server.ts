import type { Subprocess } from "bun";

let serverProcess: Subprocess | null = null;

export async function startServer(port = 3001): Promise<void> {
  serverProcess = Bun.spawn(["bun", "packages/server/src/dev.ts"], {
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait for server to be ready
  const maxWait = 10_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(200);
  }
  throw new Error("Server failed to start within 10s");
}

export function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
