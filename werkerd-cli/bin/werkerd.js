#!/usr/bin/env node
// werkerd — deploy any Cloudflare Workers project to your own infrastructure
//
// Usage:
//   werkerd deploy                Deploy current project to self-hosted server
//   werkerd deploy --port 8080    Deploy on a specific port
//   werkerd dev                    Run workerd locally for development
//   werkerd whoami                Check connection to self-hosted server

import { deploy } from "../lib/deploy.js";
import { dev } from "../lib/dev.js";
import { whoami } from "../lib/whoami.js";

const args = process.argv.slice(2);
const cmd = args[0];

const USAGE = `werkerd v1.0 — self-hosted Cloudflare Workers

Usage:
  werkerd deploy              Deploy this project to your server
  werkerd deploy --port 8080  Deploy on a specific port
  werkerd dev                 Run workerd locally (hot reload)
  werkerd whoami              Check connection to your server

Environment:
  WERKERD_SERVER   SSH target (default: root@18.171.244.124)
  WERKERD_PORT     Default port (default: 8080)
`;

switch (cmd) {
  case "deploy": {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? args[portIdx + 1] : process.env.WERKERD_PORT || "8080";
    await deploy({ port });
    break;
  }
  case "dev":
    await dev();
    break;
  case "whoami":
    await whoami();
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
