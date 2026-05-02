// lib/whoami.js — check connection to the self-hosted server

import { execSync } from "child_process";

const SERVER = process.env.WERKERD_SERVER || "root@18.171.244.124";

export async function whoami() {
  console.log(`\n  werkerd whoami\n`);
  console.log(`  Server: ${SERVER}\n`);

  try {
    const hostname = execSync(`ssh ${SERVER} "hostname"`, {
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    console.log(`  Hostname: ${hostname}`);

    const os = execSync(`ssh ${SERVER} "cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2"`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim().replace(/"/g, "");
    console.log(`  OS: ${os}`);

    // Check workerd
    try {
      const workerdVer = execSync(`ssh ${SERVER} "workerd --version 2>&1 || echo 'not found'"`, {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      console.log(`  workerd: ${workerdVer}`);
    } catch {
      console.log("  workerd: not found");
    }

    // Check Caddy
    try {
      const caddyVer = execSync(`ssh ${SERVER} "caddy version 2>&1 || echo 'not found'"`, {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      console.log(`  Caddy: ${caddyVer.split("\n")[0]}`);
    } catch {
      console.log("  Caddy: not found");
    }

    // Check running workers
    const workers = execSync(
      `ssh ${SERVER} "systemctl list-units 'workerd@*' --no-legend --no-pager 2>/dev/null | awk '{print \$1}' || echo 'none'"`,
      { encoding: "utf8", timeout: 5000 }
    ).trim();

    if (workers) {
      console.log(`\n  Running workers:`);
      for (const w of workers.split("\n")) {
        if (w.trim()) console.log(`    ${w.trim()}`);
      }
    }

    // Caddy status
    try {
      const caddy = execSync(`ssh ${SERVER} "systemctl is-active caddy"`, {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      console.log(`\n  Caddy: ${caddy}`);
    } catch { /* ignore */ }

    console.log("");
  } catch (err) {
    console.error(`  Could not connect to ${SERVER}`);
    console.error(`  ${err.message}`);
    console.error(`\n  Set WERKERD_SERVER env var if your server is elsewhere:`);
    console.error(`    export WERKERD_SERVER=root@your-server-ip\n`);
    process.exit(1);
  }
}
