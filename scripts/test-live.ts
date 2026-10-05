// Runs the live tests with ALCHEMY_WORKERS_BUILDS_LIVE=1 in the child environment
// and forwards the exit code. Node starts the Vite+ entry point directly, so no
// shell is needed on macOS, Linux, or Windows.
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const vitePlus = fileURLToPath(import.meta.resolve("vite-plus/bin"));

spawn(process.execPath, [vitePlus, "test", "--run", "test/live", ...process.argv.slice(2)], {
  env: { ...process.env, ALCHEMY_WORKERS_BUILDS_LIVE: "1" },
  stdio: "inherit",
}).on("close", (code) => {
  process.exitCode = code ?? 1;
});
