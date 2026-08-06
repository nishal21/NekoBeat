/**
 * Force all compile caches onto D: — C: is full.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = "D:\\Codesss\\cache";
const dirs = {
  CARGO_HOME: path.join(cacheRoot, "cargo"),
  CARGO_TARGET_DIR: path.join(root, "src-tauri", "target"),
  GOCACHE: path.join(cacheRoot, "go-build"),
  GOMODCACHE: path.join(cacheRoot, "go-mod"),
  GOPATH: path.join(cacheRoot, "go"),
  TMP: path.join(cacheRoot, "tmp"),
  TEMP: path.join(cacheRoot, "tmp"),
};

for (const d of Object.values(dirs)) {
  fs.mkdirSync(d, { recursive: true });
}

Object.assign(process.env, dirs);
process.chdir(root);

const args = ["tauri", "dev", "--config", "src-tauri/tauri.desktop.conf.json"];
if (process.platform === "win32") {
  args.push("--config", "src-tauri/tauri.windows.conf.json");
} else if (process.platform === "darwin") {
  args.push("--config", "src-tauri/tauri.macos.conf.json");
} else if (process.platform === "linux") {
  args.push("--config", "src-tauri/tauri.linux.conf.json");
}

const child = spawn("npx", args, {
  stdio: "inherit",
  shell: true,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
