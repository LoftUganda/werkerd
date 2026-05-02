// lib/dev.js — local development with workerd

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { readProjectConfig } from "./config-reader.js";
import { generateCapnpConfig } from "./capnp-gen.js";

export async function dev() {
  const project = readProjectConfig();
  project.port = process.env.WERKERD_PORT || "8787";

  console.log(`\n  werkerd dev - ${project.name}\n`);
  console.log(`  Local: http://localhost:${project.port}`);
  console.log(`  Entrypoint: ${project.main}\n`);
  console.log("  Watching for changes... (Ctrl+C to stop)\n");

  const cwd = process.cwd();

  function runWorkerd() {
    const capnpConfig = generateCapnpConfig(project);
    const tmpConfig = path.join(cwd, ".werkerd-tmp.capnp");
    fs.writeFileSync(tmpConfig, capnpConfig);

    const child = spawn("workerd", ["serve", tmpConfig, `--socket-addr=http=*:${project.port}`], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, ...project.vars },
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        console.error("  ERROR: workerd not found. Install it: npm install -g workerd");
      } else {
        console.error(`  ERROR: ${err.message}`);
      }
    });

    return child;
  }

  let child = runWorkerd();

  // Watch for file changes and restart
  const watcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.includes("node_modules")) return;
    if (filename.includes(".git")) return;
    if (filename.includes(".werkerd-tmp")) return;
    if (filename.endsWith(".capnp")) return;

    const fullPath = path.join(cwd, filename);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) return;
    } catch { return; }

    console.log(`\n  → ${filename} changed, restarting...\n`);
    child.kill("SIGTERM");
    child = runWorkerd();
  });

  process.on("SIGINT", () => {
    watcher.close();
    child.kill("SIGTERM");
    // Clean up temp file
    const tmpConfig = path.join(cwd, ".werkerd-tmp.capnp");
    if (fs.existsSync(tmpConfig)) fs.unlinkSync(tmpConfig);
    process.exit(0);
  });
}
