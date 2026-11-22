import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');

function shouldSkipOutput() {
  if (process.env.BURNRATE_POSTINSTALL_FORCE === '1') return false;
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  if (process.env.npm_config_silent === 'true' || process.env.npm_config_loglevel === 'silent') {
    return true;
  }
  const isGlobal = process.env.npm_config_global === 'true';
  const initCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : '';
  // Stay quiet during local repo `npm install` / `npm ci`
  if (!isGlobal && initCwd && initCwd.toLowerCase() === pkgRoot.toLowerCase()) {
    return true;
  }
  return false;
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
    return pkg.version || '1.1.0';
  } catch {
    return '1.1.0';
  }
}

function resolveBinDirectory() {
  const isWin = process.platform === 'win32';
  const envPrefix = (process.env.npm_config_prefix || process.env.PREFIX || '').trim();
  if (envPrefix) {
    return isWin ? path.resolve(envPrefix) : path.join(path.resolve(envPrefix), 'bin');
  }

  const normalizedRoot = pkgRoot.replace(/\\/g, '/');
  if (isWin && normalizedRoot.toLowerCase().includes('/node_modules/')) {
    const idx = normalizedRoot.toLowerCase().lastIndexOf('/node_modules/');
    return path.resolve(pkgRoot.slice(0, idx));
  }
  if (!isWin && normalizedRoot.includes('/lib/node_modules/')) {
    const idx = normalizedRoot.lastIndexOf('/lib/node_modules/');
    return path.join(pkgRoot.slice(0, idx), 'bin');
  }

  if (isWin) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'npm');
  }
  return '/usr/local/bin';
}

function isDirInPath(targetDir) {
  const rawPath = process.env.PATH || process.env.Path || '';
  if (!rawPath) return false;
  const isWin = process.platform === 'win32';
  const normalize = (p) => {
    const cleaned = p.trim().replace(/^"+|"+$/g, '').replace(/[\\/]+$/, '');
    return isWin ? cleaned.toLowerCase() : cleaned;
  };
  const target = normalize(targetDir);
  return rawPath
    .split(path.delimiter)
    .map(normalize)
    .some((entry) => entry === target);
}

function buildBanner() {
  const useColor = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const c = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = (t) => c('1', t);
  const dim = (t) => c('2', t);
  const green = (t) => c('32', t);
  const yellow = (t) => c('33', t);
  const cyan = (t) => c('36', t);
  const red = (t) => c('31', t);

  const version = readPackageVersion();
  const binDir = resolveBinDirectory();
  const isWin = process.platform === 'win32';
  const exePath = path.join(binDir, isWin ? 'burn.cmd' : 'burn');
  const inPath = isDirInPath(binDir);

  const lines = [
    '',
    `    ${red('(  .')}      ${bold(green('_   ___   ___ _   _ ___ _  _ ___    _ _____ ___'))}`,
    `   ${yellow(')  ) )')}    ${bold(green('/_\\ |_ _| | _ ) | | | _ \\ \\| | _ \\  /_\\_   _| __|'))}`,
    `  ${red('( (  (')}    ${bold(cyan('/ _ \\ | |  | _ \\ |_| |   / .` |   / / _ \\| | | _|'))}`,
    `   ${yellow('\\____)')}  ${bold(cyan('/_/ \\_\\___| |___/\\___/|_|_\\_|\\_|_|_\\/_/ \\_\\_| |___|'))}`,
    '',
    `  ${green('✓')} Installed ${bold('ai-burnrate-tool')} ${bold(cyan(`v${version}`))} successfully!`,
    `  ${dim('─'.repeat(60))}`,
    `  ${bold('Run:')}        ${cyan('burn')} ${dim('(live dashboard)')}  •  ${cyan('burn --cli')} ${dim('(terminal report)')}`,
    `  ${bold('Executable:')} ${dim(exePath)}`,
  ];

  if (inPath) {
    lines.push(
      `  ${bold('PATH:')}       ${green('✓')} ${dim(binDir)} ${dim('(already in PATH)')}`,
      `  ${dim(`            Reminder: if 'burn' is not found, ensure ${binDir} is in your PATH and restart your terminal.`)}`
    );
  } else {
    lines.push(
      `  ${yellow('!')} ${bold(yellow('PATH Reminder:'))} Add the executable folder to your ${bold('PATH')} to run ${cyan('burn')} from anywhere:`,
      `    ${bold(cyan(binDir))}`
    );
    if (isWin) {
      lines.push(
        `    ${dim('PowerShell:')} ${cyan(`$p=[Environment]::GetEnvironmentVariable("Path","User"); [Environment]::SetEnvironmentVariable("Path","$p;${binDir}","User")`)}`,
        `    ${dim('(Then open a new terminal window.)')}`
      );
    } else {
      lines.push(
        `    ${dim('macOS/Linux:')} ${cyan(`echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`)}`,
        `    ${dim('(Use ~/.bashrc if you are on bash.)')}`
      );
    }
  }

  lines.push(`  ${dim('─'.repeat(60))}`, '');
  return lines.join('\n');
}

function writeBanner(banner) {
  const foreground = process.env.npm_config_foreground_scripts === 'true';
  if (!foreground && process.env.BURNRATE_POSTINSTALL_FORCE !== '1') {
    const ttyPath = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
    let fd = null;
    try {
      fd = fs.openSync(ttyPath, 'w');
      fs.writeSync(fd, banner);
      return;
    } catch {
      // Non-interactive shell or no controlling TTY; fall back to stdout
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }
  process.stdout.write(banner);
}

try {
  if (!shouldSkipOutput()) {
    writeBanner(buildBanner());
  }
} catch {
  // Never fail npm install because of postinstall banner output
}
