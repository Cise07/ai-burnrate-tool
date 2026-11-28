import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NPM_PACKAGE = 'ai-burnrate-tool';
const SAFE_UPDATE_VERSION_RE = /^(?:latest|next|beta|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/;
const SAFE_NPM_ARG_RE = /^[A-Za-z0-9._@/-]+$/;

export function resolveNpmUpdateSpec(rawEnvVersion?: string): string {
  const requested = typeof rawEnvVersion === 'string' ? rawEnvVersion.trim() : '';
  if (!requested) {
    return `${NPM_PACKAGE}@latest`;
  }
  const normalized = requested.replace(/^[vV]/, '');
  if (!SAFE_UPDATE_VERSION_RE.test(normalized)) {
    throw new Error(`Unsafe or invalid BURNRATE_VERSION "${requested}". Expected semver or latest/next/beta.`);
  }
  return `${NPM_PACKAGE}@${normalized}`;
}

export function resolveNpmCliScript(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const envExecPath = env.npm_execpath?.trim();
  if (
    envExecPath &&
    /\.(?:c|m)?js$/i.test(envExecPath) &&
    path.basename(envExecPath).toLowerCase().includes('npm-cli') &&
    fs.existsSync(envExecPath)
  ) {
    return envExecPath;
  }

  const nodeDir = path.dirname(execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function runGlobalNpmCommand(args: string[], extraEnv: Record<string, string> = {}): void {
  for (const arg of args) {
    if (typeof arg !== 'string' || !SAFE_NPM_ARG_RE.test(arg)) {
      throw new Error(`Unsafe npm argument rejected: "${String(arg)}"`);
    }
  }

  const mergedEnv = { ...process.env, ...extraEnv };
  const npmCliScript = resolveNpmCliScript(process.execPath, process.env);

  if (npmCliScript) {
    execFileSync(process.execPath, [npmCliScript, ...args], {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      env: mergedEnv,
    });
    return;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('npm.cmd', args, {
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
      env: mergedEnv,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`npm.cmd exited with status ${String(result.status)}`);
    }
    return;
  }

  execFileSync('npm', args, {
    stdio: 'inherit',
    shell: false,
    env: mergedEnv,
  });
}
