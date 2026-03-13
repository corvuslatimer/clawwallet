#!/usr/bin/env node

/**
 * Bitrefill MCP local CLI (no Bitrefill package install required)
 *
 * Usage:
 *   BITREFILL_API_KEY=... node cli.js list-tools
 *   BITREFILL_API_KEY=... node cli.js call search-products --args '{"query":"netflix","country":"US"}'
 *
 * Convenience:
 *   node cli.js search --query netflix --country US
 *   node cli.js details --product_id steam-usa
 *   node cli.js buy --products '[{"product_id":"steam-usa","package_id":20}]' --payment_method usdc_solana
 *   node cli.js invoice --invoice_id <id>
 *   node cli.js orders --offset 0 --limit 20
 */

const BASE = process.env.MCP_URL || "https://api.bitrefill.com/mcp";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function has(name) {
  return process.argv.includes(name);
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
  } catch (e) {
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
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

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
  // MCP tools often return { content: [{type:'text',text:'...json...'}] }
  if (result && Array.isArray(result.content)) {
    const out = [];
    for (const item of result.content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        try {
          out.push(JSON.parse(item.text));
        } catch {
          out.push(item.text);
        }
      } else {
        out.push(item);
      }
    }
    console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

function help() {
  console.log(`Bitrefill local CLI\n
Commands:
  list-tools
  call <toolName> [--args '{...json...}']

Convenience:
  search --query <text> [--country US] [--product_type giftcard|esim] [--category <slug>]
  details --product_id <slug>
  buy --products '[{...}]' --payment_method <method> [--return_payment_link true|false]
  invoice --invoice_id <id>
  orders [--offset 0] [--limit 20]

Auth:
  --api-key <key>  or BITREFILL_API_KEY env var
`);
}

async function main() {
  const c = cmd();

  if (c === "help" || c === "--help" || c === "-h") {
    help();
    return;
  }

  if (c === "list-tools") {
    const r = await rpc("tools/list", {});
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (c === "call") {
    const toolName = process.argv[3];
    if (!toolName) {
      console.error("Usage: call <toolName> [--args '{...json...}']");
      process.exit(1);
    }
    const argsRaw = arg("--args", "{}");
    const args = parseJson(argsRaw, "--args");
    const r = await rpc("tools/call", { name: toolName, arguments: args });
    printResult(r);
    return;
  }

  if (c === "search") {
    const query = arg("--query");
    if (!query) {
      console.error("Usage: search --query <text> [--country US] [--product_type ...] [--category ...]");
      process.exit(1);
    }
    const args = { query };
    if (arg("--country")) args.country = arg("--country");
    if (arg("--product_type")) args.product_type = arg("--product_type");
    if (arg("--category")) args.category = arg("--category");

    const r = await rpc("tools/call", { name: "search-products", arguments: args });
    printResult(r);
    return;
  }

  if (c === "details") {
    const product_id = arg("--product_id");
    if (!product_id) {
      console.error("Usage: details --product_id <slug>");
      process.exit(1);
    }
    const r = await rpc("tools/call", {
      name: "get-product-details",
      arguments: { product_id },
    });
    printResult(r);
    return;
  }

  if (c === "buy") {
    const productsRaw = arg("--products");
    const payment_method = arg("--payment_method");
    if (!productsRaw || !payment_method) {
      console.error("Usage: buy --products '[{...}]' --payment_method <method> [--return_payment_link true|false]");
      process.exit(1);
    }
    const products = parseJson(productsRaw, "--products");
    const args = { products, payment_method };
    if (arg("--return_payment_link")) {
      args.return_payment_link = ["true", "1", "yes"].includes(String(arg("--return_payment_link")).toLowerCase());
    }

    const r = await rpc("tools/call", { name: "buy-products", arguments: args });
    printResult(r);
    return;
  }

  if (c === "invoice") {
    const invoice_id = arg("--invoice_id");
    if (!invoice_id) {
      console.error("Usage: invoice --invoice_id <id>");
      process.exit(1);
    }
    const r = await rpc("tools/call", {
      name: "get-invoice-by-id",
      arguments: { invoice_id },
    });
    printResult(r);
    return;
  }

  if (c === "orders") {
    const args = {};
    if (arg("--offset")) args.offset = Number(arg("--offset"));
    if (arg("--limit")) args.limit = Number(arg("--limit"));
    const r = await rpc("tools/call", { name: "list-orders", arguments: args });
    printResult(r);
    return;
  }

  console.error(`Unknown command: ${c}`);
  help();
  process.exit(1);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
