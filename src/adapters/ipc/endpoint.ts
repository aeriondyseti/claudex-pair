import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

export function normalizedRoot(root: string): string {
  const value = resolve(root).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function endpointFor(root: string, epoch: number, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash('sha256').update(normalizedRoot(root)).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\claudex-${hash}-e${epoch}`;
  const runtime = process.env.XDG_RUNTIME_DIR || tmpdir();
  return `${runtime}/claudex-${hash}-e${epoch}.sock`;
}

export function electionEndpointFor(root: string, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash('sha256').update(normalizedRoot(root)).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\claudex-${hash}-lock`;
  const runtime = process.env.XDG_RUNTIME_DIR || tmpdir();
  return `${runtime}/claudex-${hash}-lock.sock`;
}
