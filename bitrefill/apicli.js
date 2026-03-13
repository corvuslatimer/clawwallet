#!/usr/bin/env node

// Bitrefill API-key mode (no OAuth)
// Usage:
//   BITREFILL_API_KEY=... node apicli.js list-tools
//   BITREFILL_API_KEY=... node apicli.js call search-products --args '{"query":"netflix","country":"US"}'

const BASE = process.env.MCP_URL || "https://api.bitrefill.com/mcp";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function cmd() {
  return process.argv[2] || "help";
}

function apiKey() {
  return arg("--api-key", process.env.BITREFILL_API_KEY);
}

function endpoint() {
  const key = apiKey();
  if (!key) {
    console.error("Missing API key. Use --api-key or BITREFILL_API_KEY env var.");
    process.exit(1);
  }
  return `${BASE}/${key}`;
}

function parseJson(s, label) {
  try {
    return JSON.parse(s);
  } catch {
    console.error(`Invalid JSON for ${label}`);
    process.exit(1);
  }
}

async function rpc(method, params) {
  const url = endpoint();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!res.ok) {
    console.error(JSON.stringify({ status: res.status, body }, null, 2));
    process.exit(1);
  }
  if (body.error) {
    console.error(JSON.stringify(body.error, null, 2));
    process.exit(1);
  }
  return body.result;
}

function printResult(result) {
  if (result && Array.isArray(result.content)) {
    const out = [];
    for (const item of result.content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        try { out.push(JSON.parse(item.text)); } catch { out.push(item.text); }
      } else out.push(item);
    }
    console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function help() {
  console.log(`Bitrefill API CLI\n\nCommands:\n  list-tools\n  call <toolName> [--args '{...json...}']\n  search --query <text> [--country US]\n  details --product_id <slug>\n  buy --products '[{...}]' --payment_method <method>\n  invoice --invoice_id <id>\n  orders [--offset 0] [--limit 20]\n`);
}

async function main() {
  const c = cmd();
  if (["help", "--help", "-h"].includes(c)) return help();

  if (c === "list-tools") {
    const r = await rpc("tools/list", {});
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (c === "call") {
    const toolName = process.argv[3];
    if (!toolName) throw new Error("Usage: call <toolName> [--args '{...json...}']");
    const args = parseJson(arg("--args", "{}"), "--args");
    const r = await rpc("tools/call", { name: toolName, arguments: args });
    printResult(r);
    return;
  }

  if (c === "search") {
    const query = arg("--query");
    if (!query) throw new Error("Usage: search --query <text> [--country US]");
    const a = { query };
    if (arg("--country")) a.country = arg("--country");
    if (arg("--product_type")) a.product_type = arg("--product_type");
    if (arg("--category")) a.category = arg("--category");
    const r = await rpc("tools/call", { name: "search-products", arguments: a });
    printResult(r);
    return;
  }

  if (c === "details") {
    const product_id = arg("--product_id");
    if (!product_id) throw new Error("Usage: details --product_id <slug>");
    const r = await rpc("tools/call", { name: "get-product-details", arguments: { product_id } });
    printResult(r);
    return;
  }

  if (c === "buy") {
    const products = parseJson(arg("--products", ""), "--products");
    const payment_method = arg("--payment_method");
    if (!products || !payment_method) throw new Error("Usage: buy --products '[{...}]' --payment_method <method>");
    const args = { products, payment_method };
    if (arg("--return_payment_link")) args.return_payment_link = ["true","1","yes"].includes(String(arg("--return_payment_link")).toLowerCase());
    const r = await rpc("tools/call", { name: "buy-products", arguments: args });
    printResult(r);
    return;
  }

  if (c === "invoice") {
    const invoice_id = arg("--invoice_id");
    if (!invoice_id) throw new Error("Usage: invoice --invoice_id <id>");
    const r = await rpc("tools/call", { name: "get-invoice-by-id", arguments: { invoice_id } });
    printResult(r);
    return;
  }

  if (c === "orders") {
    const a = {};
    if (arg("--offset")) a.offset = Number(arg("--offset"));
    if (arg("--limit")) a.limit = Number(arg("--limit"));
    const r = await rpc("tools/call", { name: "list-orders", arguments: a });
    printResult(r);
    return;
  }

  throw new Error(`Unknown command: ${c}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
