// lib/deploy.js — deploy any Cloudflare Workers project to your own workerd infrastructure
//
// Auto-bundles with esbuild. Reads wrangler.jsonc. Zero config editing.
// Just run `werkerd deploy` in your project directory.

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { readProjectConfig } from "./config-reader.js";
import { generateCapnpConfig } from "./capnp-gen.js";

const SERVER = process.env.WERKERD_SERVER || "root@18.171.244.124";

export async function deploy({ port }) {
  const project = readProjectConfig();
  project.port = port;
  const cwd = process.cwd();

  console.log(`\n  werkerd deploy · ${project.name}\n`);
  console.log(`  Server:     ${SERVER}`);
  console.log(`  Port:       ${port}`);
  console.log(`  Entrypoint: ${project.main}`);
  if (Object.keys(project.vars).length) console.log(`  Vars:       ${Object.keys(project.vars).join(", ")}`);
  if (project.bindings.length) console.log(`  Bindings:   ${project.bindings.map(b => `${b.type}:${b.name}`).join(", ")}`);
  console.log("");

  const mainFile = path.resolve(project.main);
  if (!fs.existsSync(mainFile)) die(`Entrypoint not found: ${mainFile}`);

  // Step 1: Bundle
  const entryName = path.basename(project.main);
  let bundleScript;
  const needsBundle = hasNpmDeps(mainFile) || project.assets?.directory;

  if (needsBundle) {
    console.log("  → Bundling with esbuild...");
    try {
      execSync(
        `npx -y esbuild ${JSON.stringify(project.main)} --bundle --format=esm --platform=browser --outfile=/tmp/werkerd-bundle.js`,
        { cwd, stdio: "pipe", timeout: 60000 }
      );
      bundleScript = fs.readFileSync("/tmp/werkerd-bundle.js", "utf8");
      console.log("  ✓ Bundled");
    } catch (e) {
      die("esbuild failed. Make sure dependencies are installed (npm install)");
    }
  } else {
    bundleScript = fs.readFileSync(mainFile, "utf8");
  }

  // Step 2: Generate Cap'n Proto config
  const capnpConfig = generateCapnpConfig(project);

  // Step 3: Upload to server
  const remoteDir = `/etc/workerd/workers/${project.name}`;
  const tmpDir = fs.mkdtempSync("/tmp/werkerd-deploy-");
  fs.writeFileSync(path.join(tmpDir, entryName), bundleScript);
  fs.writeFileSync(path.join(tmpDir, `config.${port}.capnp`), capnpConfig);

  if (Object.keys(project.vars).length) {
    const envLines = Object.entries(project.vars).map(([k, v]) => `${k}=${v}`).join("\n");
    fs.writeFileSync(path.join(tmpDir, ".env"), envLines + "\n");
  }

  // Copy project .env if it exists (for secrets, DO keys, etc.)
  const projectEnv = path.join(cwd, ".env");
  if (fs.existsSync(projectEnv)) {
    fs.copyFileSync(projectEnv, path.join(tmpDir, ".env"));
    console.log("  ✓ Copied .env (secrets)");
  }

  console.log("  → Uploading...");
  execSync(`ssh ${SERVER} "mkdir -p ${remoteDir}"`, { stdio: "pipe" });
  execSync(`scp -r ${tmpDir}/* ${SERVER}:${remoteDir}/`, { stdio: "pipe" });

  // Create manifest.json for workerd-gen-config (needed for scaling)
  const manifest = {
    name: project.name,
    entrypoint: entryName,
    compatibilityDate: project.compatibilityDate,
    moduleType: "esm",
  };
  execSync(
    `ssh ${SERVER} "cat > ${remoteDir}/manifest.json << 'MANIFESTEOF'\n${JSON.stringify(manifest, null, 2)}\nMANIFESTEOF"`,
    { stdio: "pipe" }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.unlinkSync("/tmp/werkerd-bundle.js"); } catch {}

  // Step 4: Create socket unit, start service
  console.log("  → Starting service...");
  const sockUnit = `workerd-${project.name}-${port}.socket`;
  const svcUnit = `workerd@${project.name}:${port}.service`;

  const remoteScript = `#!/bin/bash
set -e
WORKER="${project.name}"
PORT="${port}"
SOCK_UNIT="${sockUnit}"
SVC_UNIT="${svcUnit}"

systemctl stop "$SVC_UNIT" 2>/dev/null || true
systemctl stop "$SOCK_UNIT" 2>/dev/null || true
systemctl reset-failed "$SVC_UNIT" 2>/dev/null || true

mkdir -p "/etc/workerd/workers/$WORKER"
echo "$PORT" >> "/etc/workerd/workers/$WORKER/ports"
sort -u -o "/etc/workerd/workers/$WORKER/ports" "/etc/workerd/workers/$WORKER/ports"

cat > "/etc/systemd/system/$SOCK_UNIT" << UNIT
[Unit]
Description=Socket for workerd \${WORKER}:\${PORT}
[Socket]
ListenStream=0.0.0.0:\${PORT}
NoDelay=true
Service=\${SVC_UNIT}
[Install]
WantedBy=sockets.target
UNIT

systemctl daemon-reload
systemctl enable --now "$SOCK_UNIT"
/usr/local/bin/workerd-gen-nginx 2>/dev/null || true
nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
echo "OK"
`;

  const rsPath = "/tmp/werkerd-start-svc.sh";
  fs.writeFileSync(rsPath, remoteScript);
  execSync(`scp ${rsPath} ${SERVER}:${rsPath}`, { stdio: "pipe" });
  execSync(`ssh ${SERVER} "bash ${rsPath}"`, { encoding: "utf8", timeout: 30000 });
  try { fs.unlinkSync(rsPath); } catch {}

  // Step 5: Health check
  console.log("  → Health check...");
  await sleep(2000);
  try {
    const health = execSync(
      `ssh ${SERVER} "curl -sf http://localhost:${port}/healthz 2>/dev/null || curl -sf http://localhost:${port}/"`,
      { encoding: "utf8", stdio: "pipe", timeout: 5000 }
    );
    console.log(`  ✓ Live on :${port}`);
    if (health.trim().length < 200) console.log(`    ${health.trim().split("\n")[0]}`);
  } catch {
    console.log(`  ⚠ Not reachable yet. Check logs:`);
    console.log(`    ssh ${SERVER} journalctl -u ${svcUnit} -n 20`);
  }

  console.log(`\n  ✓ ${project.name} deployed on port ${port}\n`);
}

function hasNpmDeps(entryPath) {
  try {
    const src = fs.readFileSync(entryPath, "utf8");
    const matches = src.match(/from\s+["']([^"']+)["']/g) || [];
    for (const m of matches) {
      const spec = m.replace(/^from\s+["']/, "").replace(/["']$/, "");
      if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("http")) return true;
    }
  } catch {}
  return false;
}

function die(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
