// lib/capnp-gen.js — generates workerd Cap'n Proto config from a normalized project config

export function generateCapnpConfig(project) {
  const { name: workerName, main, compatibilityDate, port, vars, bindings, durableObjects: dos } = project;
  const entrypoint = main.split("/").pop(); // just the filename (bundled flat)

  // Collect services for service bindings
  const serviceBindings = bindings.filter(b => b.type === "service");
  const services = [workerName, ...serviceBindings.map(s => s.service)];

  const servicesBlock = services.map(s =>
    `    (name = "${s}", worker = .${toCapnpIdent(s)}Worker),`
  ).join("\n");

  // Durable Object namespaces block (goes on Worker, NOT Config)
  const doWorkerBlock = dos.length > 0
    ? ",\n  durableObjectNamespaces = [\n" +
      dos.map(d => `    ( className = "${d.className}", uniqueKey = "${d.uniqueKey}" )`).join(",\n") +
      "\n  ],\n  durableObjectStorage = (inMemory = void)"
    : "";

  // Bindings for the main worker
  const bindingLines = [];
  for (const b of bindings) {
    switch (b.type) {
      case "kvNamespace":
        bindingLines.push(`    ( name = "${b.name}", kvNamespace = ( service = "${b.namespace}" ) )`);
        break;
      case "r2Bucket":
        bindingLines.push(`    ( name = "${b.name}", r2Bucket = "${b.bucket}" )`);
        break;
      case "durableObjectNamespace":
        bindingLines.push(`    ( name = "${b.name}", durableObjectNamespace = ( className = "${b.className}" ) )`);
        break;
      case "queue":
        bindingLines.push(`    ( name = "${b.name}", queue = "${b.queue}" )`);
        break;
      case "service":
        bindingLines.push(`    ( name = "${b.name}", service = "${b.service}" )`);
        break;
    }
  }

  // wrangler vars = text bindings (values are in the config, not env)
  for (const [key, value] of Object.entries(vars)) {
    bindingLines.push(`    ( name = "${key}", text = ${JSON.stringify(value)} )`);
  }

  const bindingsBlock = bindingLines.length > 0
    ? ",\n  bindings = [\n" + bindingLines.join(",\n") + "\n  ]"
    : "";

  // Other workers (service binding targets) — minimal stubs
  const otherWorkerBlocks = serviceBindings.map(s => {
    const sid = toCapnpIdent(s.service);
    return `const ${sid}Worker :Workerd.Worker = (
  modules = [ ( name = "${entrypoint}", esModule = embed "${entrypoint}" ) ],
  compatibilityDate = "${compatibilityDate}"
);`;
  }).join("\n\n");

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${servicesBlock}
  ],
  sockets = [
    ( name    = "http",
      address = "*:${port}",
      http    = (),
      service = "${workerName}"
    ),
  ]
);

const ${toCapnpIdent(workerName)}Worker :Workerd.Worker = (
  modules = [ ( name = "${entrypoint}", esModule = embed "${entrypoint}" ) ],
  compatibilityDate = "${compatibilityDate}"${bindingsBlock}${doWorkerBlock}
);

${otherWorkerBlocks}
`;
}

function toCapnpIdent(name) {
  // Cap'n Proto requires camelCase — no underscores, no hyphens
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
}
