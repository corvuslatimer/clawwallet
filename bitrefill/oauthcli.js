#!/usr/bin/env node

// Wrapper so we keep a .js filename for OAuth mode.
// Delegates to cli.mjs (MCP OAuth implementation).

const { spawn } = require('node:child_process');

const child = spawn(process.execPath, ['./cli.mjs', ...process.argv.slice(2)], {
  cwd: __dirname,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error(err?.message || err);
  process.exit(1);
});
