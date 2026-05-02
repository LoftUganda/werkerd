// lib/config-reader.js — reads wrangler.jsonc or wrangler.toml and returns a normalized project config

import fs from "fs";
import path from "path";

export function readProjectConfig(dir = process.cwd()) {
  // Try wrangler.jsonc first, then wrangler.toml
  const jsoncPath = path.join(dir, "wrangler.jsonc");
  const tomlPath = path.join(dir, "wrangler.toml");
  const jsonPath = path.join(dir, "wrangler.json");

  let raw = null;
  let format = null;

  if (fs.existsSync(jsoncPath)) {
    raw = fs.readFileSync(jsoncPath, "utf8");
    format = "jsonc";
  } else if (fs.existsSync(jsonPath)) {
    raw = fs.readFileSync(jsonPath, "utf8");
    format = "json";
  } else if (fs.existsSync(tomlPath)) {
    raw = fs.readFileSync(tomlPath, "utf8");
    format = "toml";
  }

  if (!raw) {
    console.error("No wrangler.jsonc, wrangler.json, or wrangler.toml found.");
    console.error("Run this command from a Cloudflare Workers project directory.");
    process.exit(1);
  }

  let cfg;
  if (format === "toml") {
    cfg = parseToml(raw);
  } else {
    cfg = parseJsonc(raw);
  }

  return normalizeConfig(cfg, dir);
}

function parseJsonc(raw) {
  // Strip single-line comments, then parse JSON
  const stripped = raw
    .split("\n")
    .map(line => line.replace(/(?<!https?:)\/\/.*$/, ""))
    .join("\n");
  return JSON.parse(stripped);
}

function parseToml(raw) {
  // Minimal TOML parser for wrangler.toml subset
  const result = {};
  let currentSection = result;
  const sectionStack = [result];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Section header: [section] or [[array]]
    const sectionMatch = trimmed.match(/^\[\[?([^\]]+)\]\]?$/);
    if (sectionMatch) {
      const parts = sectionMatch[1].split(".");
      currentSection = result;
      for (const part of parts) {
        if (!currentSection[part]) currentSection[part] = {};
        currentSection = currentSection[part];
      }
      continue;
    }

    // Key = value
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    currentSection[key] = isNaN(val) ? val : Number(val);
  }

  return result;
}

function normalizeConfig(cfg, dir) {
  const result = {
    name: cfg.name || path.basename(dir),
    main: cfg.main || "src/index.js",
    compatibilityDate: cfg.compatibility_date || cfg.compatibilityDate || "2024-09-23",
    port: cfg.port || 8080,
    vars: {},
    bindings: [],
    durableObjects: [],
    routes: cfg.routes || [],
    assets: cfg.assets || null,
  };

  // Environment variables
  const vars = cfg.vars || {};
  for (const [k, v] of Object.entries(vars)) {
    result.vars[k] = String(v);
  }

  // KV namespaces
  for (const kv of (cfg.kv_namespaces || [])) {
    result.bindings.push({
      type: "kvNamespace",
      name: kv.binding,
      namespace: kv.id || kv.binding,
    });
  }

  // R2 buckets
  for (const r2 of (cfg.r2_buckets || [])) {
    result.bindings.push({
      type: "r2Bucket",
      name: r2.binding,
      bucket: r2.bucket_name || r2.binding,
    });
  }

  // D1 databases
  for (const d1 of (cfg.d1_databases || [])) {
    result.bindings.push({
      type: "d1Database",
      name: d1.binding,
      db: d1.database_id || d1.binding,
    });
  }

  // Durable Objects
  for (const d of (cfg.durable_objects?.bindings || [])) {
    result.bindings.push({
      type: "durableObjectNamespace",
      name: d.name,
      className: d.class_name,
    });
    result.durableObjects.push({
      className: d.class_name,
      uniqueKey: d.class_name + "-key",
    });
  }

  // Queues
  for (const q of (cfg.queues?.producers || [])) {
    result.bindings.push({
      type: "queue",
      name: q.binding,
      queue: q.queue,
    });
  }

  // Service bindings
  for (const s of (cfg.services || [])) {
    result.bindings.push({
      type: "service",
      name: s.binding,
      service: s.service,
    });
  }

  return result;
}
