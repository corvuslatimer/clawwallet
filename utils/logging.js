// NOTE: currently unused by cli.js command routes; optional helper for file logging.
const fs = require('fs');
const path = require('path');

function setupConsoleFileLogging(logFile = path.join(__dirname, '..', 'logs.txt')) {
  const originalConsoleLog = console.log;
  console.log = function (...args) {
    originalConsoleLog.apply(console, args);
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${args.join(' ')}\n`;
    fs.appendFileSync(logFile, logEntry, 'utf8');
  };
}

function log(...args) {
  console.log(...args);
}

function logJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

module.exports = { setupConsoleFileLogging, log, logJson };