#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const BASE_MCP_URL = 'https://api.bitrefill.com/mcp';
const CALLBACK_PORT = 8098;
const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const STATE_DIR = path.join(os.homedir(), '.config', 'clawwallet-bitrefill');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function cmd() {
  return process.argv[2] || 'help';
}

function resolveApiKey() {
  return arg('--api-key', process.env.BITREFILL_API_KEY);
}

function resolveMcpUrl(apiKey) {
  if (process.env.MCP_URL) return process.env.MCP_URL;
  if (apiKey) return `${BASE_MCP_URL}/${apiKey}`;
  return BASE_MCP_URL;
}

function stateFilePath(serverUrl) {
  const host = new URL(serverUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  return path.join(STATE_DIR, `${host}.json`);
}

function loadState(serverUrl) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(serverUrl), 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(serverUrl, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFilePath(serverUrl), JSON.stringify(state, null, 2));
}

function openBrowser(url) {
  try {
    const p = process.platform;
    if (p === 'darwin') execSync(`open "${url}"`);
    else if (p === 'win32') execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {}
}

function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404); res.end(); return;
      }
      const parsed = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
      const code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorized</h1><p>You can close this tab.</p>');
        resolve(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Failed</h1><p>${error ?? 'Unknown'}</p>`);
        reject(new Error(`OAuth error: ${error}`));
      }
      setTimeout(() => server.close(), 1200);
    });
    server.listen(CALLBACK_PORT, '127.0.0.1');
    server.on('error', reject);
  });
}

function createOAuthProvider(serverUrl) {
  let state = loadState(serverUrl);
  const persist = () => saveState(serverUrl, state);

  return {
    get redirectUrl() { return CALLBACK_URL; },
    get clientMetadata() {
      return {
        client_name: 'Clawwallet Bitrefill',
        redirect_uris: [CALLBACK_URL],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      };
    },
    clientInformation() { return state.clientInfo; },
    saveClientInformation(info) { state.clientInfo = info; persist(); },
    tokens() { return state.tokens; },
    saveTokens(t) { state.tokens = t; persist(); },
    redirectToAuthorization(url) {
      console.log(`\nSign in using this link:\n${url.toString()}\n`);
      openBrowser(url.toString());
    },
    saveCodeVerifier(v) { state.codeVerifier = v; persist(); },
    codeVerifier() { if (!state.codeVerifier) throw new Error('No code verifier saved'); return state.codeVerifier; },
    discoveryState() { return state.discoveryState; },
    saveDiscoveryState(ds) { state.discoveryState = ds; persist(); },
    invalidateCredentials(scope) {
      if (scope === 'all') state = {};
      else if (scope === 'tokens') delete state.tokens;
      else if (scope === 'client') delete state.clientInfo;
      else if (scope === 'verifier') delete state.codeVerifier;
      else if (scope === 'discovery') delete state.discoveryState;
      persist();
    },
  };
}

async function createClient(url, useOAuth) {
  const suppressNoise = (err) => {
    if (err instanceof UnauthorizedError) return;
    if (String(err?.message || '').includes('SSE stream disconnected')) return;
    if (String(err?.message || '').includes('Failed to open SSE stream')) return;
    console.error('Client error:', err);
  };

  if (!useOAuth) {
    const client = new Client({ name: 'clawwallet-bitrefill', version: '0.1.0' });
    client.onerror = suppressNoise;
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    return { client, transport };
  }

  const authProvider = createOAuthProvider(url);

  try {
    const client = new Client({ name: 'clawwallet-bitrefill', version: '0.1.0' });
    client.onerror = suppressNoise;
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider });
    await client.connect(transport);
    return { client, transport };
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;

    console.log('Authorization required...');
    const code = await waitForCallback();
    const client = new Client({ name: 'clawwallet-bitrefill', version: '0.1.0' });
    client.onerror = suppressNoise;
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider });
    await transport.finishAuth(code);
    await client.connect(transport);
    return { client, transport };
  }
}

function parseJsonOrEmpty(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON for --args'); }
}

function printResult(result) {
  if (result && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        try { console.log(JSON.stringify(JSON.parse(item.text), null, 2)); }
        catch { console.log(item.text); }
      } else {
        console.log(JSON.stringify(item, null, 2));
      }
    }
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function help() {
  console.log(`Bitrefill MCP (OAuth + API key)\n\nUsage:\n  node bitrefill/cli.mjs login\n  node bitrefill/cli.mjs logout\n  node bitrefill/cli.mjs list-tools\n  node bitrefill/cli.mjs call <toolName> --args '{...json...}'\n\nAuth:\n  - OAuth magic-link (default when no API key)\n  - API key via --api-key or BITREFILL_API_KEY`);
}

async function main() {
  const command = cmd();
  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }

  const key = resolveApiKey();
  const mcpUrl = resolveMcpUrl(key);
  const useOAuth = !key && !process.env.MCP_URL;

  if (command === 'logout') {
    try {
      fs.unlinkSync(stateFilePath(mcpUrl));
      console.log('Cleared stored OAuth credentials.');
    } catch {
      console.log('No stored OAuth credentials.');
    }
    return;
  }

  const { client, transport } = await createClient(mcpUrl, useOAuth);

  try {
    if (command === 'login') {
      console.log('Bitrefill auth is ready.');
      return;
    }

    if (command === 'list-tools') {
      const tools = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
      console.log(JSON.stringify(tools, null, 2));
      return;
    }

    if (command === 'call') {
      const toolName = process.argv[3];
      if (!toolName) throw new Error('Usage: call <toolName> --args \'{...json}\'');
      const argsRaw = arg('--args', '{}');
      const args = parseJsonOrEmpty(argsRaw);
      const result = await client.request(
        { method: 'tools/call', params: { name: toolName, arguments: args } },
        CallToolResultSchema
      );
      printResult(result);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    await transport.close();
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
