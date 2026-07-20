const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isWindows = process.platform === 'win32';

function findLibreTranslateBinary() {
  if (process.env.LIBRETRANSLATE_BIN) return process.env.LIBRETRANSLATE_BIN;

  if (!isWindows) return commandExists('libretranslate') ? 'libretranslate' : null;

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const pythonRoot = path.join(localAppData, 'Programs', 'Python');
  if (!fs.existsSync(pythonRoot)) return null;

  const candidates = fs
    .readdirSync(pythonRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^Python\d+/i.test(entry.name))
    .map((entry) => path.join(pythonRoot, entry.name, 'Scripts', 'libretranslate.exe'))
    .filter((candidate) => fs.existsSync(candidate))
    .sort()
    .reverse();

  return candidates[0] ?? null;
}

function findPythonBinary() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;

  if (!isWindows) {
    if (commandExists('python3')) return 'python3';
    if (commandExists('python')) return 'python';
    return null;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const pythonRoot = path.join(localAppData, 'Programs', 'Python');
  if (!fs.existsSync(pythonRoot)) return null;

  const candidates = fs
    .readdirSync(pythonRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^Python\d+/i.test(entry.name))
    .map((entry) => path.join(pythonRoot, entry.name, 'python.exe'))
    .filter((candidate) => fs.existsSync(candidate))
    .sort()
    .reverse();

  return candidates[0] ?? null;
}

function commandExists(command) {
  const checker = isWindows ? 'where.exe' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function ensureLibreTranslateInstalled() {
  let binary = findLibreTranslateBinary();
  if (binary) return binary;

  if (process.env.AUTO_INSTALL_LIBRETRANSLATE === 'false') return null;

  const python = findPythonBinary();
  if (!python) return null;

  console.log('[translate] LibreTranslate is not installed. Installing with pip...');
  const install = spawnSync(python, ['-m', 'pip', 'install', 'libretranslate'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (install.status !== 0) return null;
  binary = findLibreTranslateBinary();
  return binary;
}

const binary = ensureLibreTranslateInstalled();
const defaultArgs = ['--load-only', process.env.LIBRETRANSLATE_LOAD_ONLY || 'en,vi'];
const args = process.argv.length > 2 ? process.argv.slice(2) : defaultArgs;

if (!binary) {
  console.error('[translate] Cannot find or install LibreTranslate.');
  console.error('[translate] Install it manually:');
  console.error(
    '& "C:\\Users\\lekho\\AppData\\Local\\Programs\\Python\\Python313\\python.exe" -m pip install libretranslate',
  );
  process.exit(1);
}

const child = spawn(binary, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`[translate] Cannot start LibreTranslate: ${error.message}`);
  console.error('[translate] Install it first:');
  console.error(
    '& "C:\\Users\\lekho\\AppData\\Local\\Programs\\Python\\Python313\\python.exe" -m pip install libretranslate',
  );
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
