const { spawn } = require('node:child_process');

const isWindows = process.platform === 'win32';
const pnpmCommand = isWindows ? 'pnpm.cmd' : 'pnpm';
const children = new Set();

function prefixOutput(name, stream) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) console.log(`[${name}] ${line}`);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) console.log(`[${name}] ${buffer}`);
  });
}

function spawnNamed(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: isWindows,
    stdio: ['inherit', 'pipe', 'pipe'],
    ...options,
  });

  children.add(child);
  prefixOutput(name, child.stdout);
  prefixOutput(name, child.stderr);

  child.on('error', (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    children.delete(child);
    if (signal) {
      console.log(`[${name}] stopped by ${signal}`);
      return;
    }
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });

  return child;
}

function shutdown(signal) {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const loadOnly = process.env.LIBRETRANSLATE_LOAD_ONLY || 'en,vi';

console.log(`[dev] Starting LibreTranslate with --load-only ${loadOnly}`);
spawnNamed('translate', pnpmCommand, ['run', 'dev:translate']);

console.log('[dev] Starting NestJS watch server');
spawnNamed('api', pnpmCommand, ['run', 'dev:api']);
