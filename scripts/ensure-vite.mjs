/**
 * Tauri beforeDevCommand — only treat Vite as ready if HTTP 200 on / .
 * Stale listeners on :1420 were leaving WebView on a dead port → grey Not Responding.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const HOST = "127.0.0.1";
const PORT = 1420;
const URL = `http://${HOST}:${PORT}/`;

function httpOk(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(URL, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForVite(ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await httpOk()) return true;
    await sleep(400);
  }
  return false;
}

if (await httpOk()) {
  console.log(`[ensure-vite] healthy at ${URL}`);
  setInterval(() => {}, 1 << 30);
} else {
  console.log(`[ensure-vite] starting Vite (port free or unhealthy)…`);
  const child = spawn("npm", ["run", "dev", "--", "--host", HOST, "--port", String(PORT)], {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    console.error(`[ensure-vite] Vite exited code=${code} signal=${signal}`);
    process.exit(code ?? 1);
  });
  const ok = await waitForVite();
  if (!ok) {
    console.error(`[ensure-vite] timed out waiting for ${URL}`);
    child.kill();
    process.exit(1);
  }
  console.log(`[ensure-vite] Vite ready at ${URL}`);
  setInterval(() => {}, 1 << 30);
}
