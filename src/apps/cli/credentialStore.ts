import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizedRoot } from '@adapters/ipc/endpoint.ts';

/**
 * U1 user-channel credential store (U1-SLICE3-DESIGN.md, approved; user
 * decision: DPAPI user-scope under %LOCALAPPDATA%\claudex).
 *
 * The token never touches the repo, env vars, or `.pair/`. On Windows it is
 * DPAPI-protected (CurrentUser) — the honest `trusted_user_client` bar:
 * forging requires deliberate DPAPI decryption as this OS user, not an
 * incidental repo/env read. Elsewhere: a 0600 file, honestly weaker.
 *
 * Recovery contract (frozen): a present-but-undecryptable credential is a
 * LOUD error — never silent regeneration (the journal binding would reject
 * a fresh token anyway; slice 3 has no reset). A MISSING credential may be
 * created; if a binding already exists the broker rejects the new token
 * with user-auth-failed and the host renders guidance.
 */

export type CredentialResult =
  | { kind: 'loaded' | 'created'; token: string }
  | { kind: 'error'; detail: string };

function credentialPath(root: string): string {
  const hash = createHash('sha256').update(normalizedRoot(root)).digest('hex').slice(0, 16);
  const base = process.platform === 'win32'
    ? (process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
    : join(homedir(), '.local', 'share');
  return join(base, 'claudex', 'user', `${hash}.cred`);
}

/** 32 random bytes as lowercase hex — the frozen wire encoding. */
const newToken = (): string => randomBytes(32).toString('hex');
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Off-Windows there is no DPAPI: fail closed unless the user explicitly
 * opts into a plaintext 0600 file (their credential decision was DPAPI). */
const plaintextFallbackAllowed = (): boolean => process.env['CLAUDEX_ALLOW_PLAINTEXT_CRED'] === '1';

export async function loadOrCreateUserToken(root: string, options: { createIfMissing: boolean } = { createIfMissing: true }): Promise<CredentialResult> {
  const path = credentialPath(root);
  if (process.platform !== 'win32' && !plaintextFallbackAllowed()) {
    return { kind: 'error', detail: 'DPAPI is unavailable on this platform. Set CLAUDEX_ALLOW_PLAINTEXT_CRED=1 to explicitly accept a plaintext 0600 credential file instead.' };
  }
  if (existsSync(path)) {
    try {
      const stored = (await readFile(path, 'utf8')).trim();
      const token = process.platform === 'win32' ? dpapiUnprotect(stored) : stored;
      if (!TOKEN_PATTERN.test(token)) return { kind: 'error', detail: `Credential at ${path} decrypted to an invalid token — it may be corrupt. Slice 3 has no reset; keep the file for forensics and ask the broker owner.` };
      return { kind: 'loaded', token };
    } catch (error) {
      return { kind: 'error', detail: `Credential at ${path} exists but cannot be decrypted (${message(error)}). Never regenerated silently — if the session binding is yours, restore the credential; otherwise this pane stays read-only.` };
    }
  }
  if (!options.createIfMissing) {
    return { kind: 'error', detail: `No user credential at ${path}, but this session already has a registered user channel. The credential is NOT regenerated (slice 3 has no reset) — restore the file, or the pane stays read-only.` };
  }
  const token = newToken();
  await mkdir(join(path, '..'), { recursive: true });
  const stored = process.platform === 'win32' ? dpapiProtect(token) : token;
  try {
    // Exclusive create: two first watch panes race — the loser must NEVER
    // overwrite the winner's credential (codex slice review #3).
    await writeFile(path, stored, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateUserToken(root, { createIfMissing: false });
    throw error;
  }
  await chmod(path, 0o600).catch(() => undefined);
  return { kind: 'created', token };
}

/**
 * DPAPI via PowerShell interop — no native Node binding exists, and pwsh is
 * a hard dependency of this repo already (bin/pair.ps1). CurrentUser scope.
 * The SECRET travels on STDIN, never the command line: argv is visible to
 * incidental process inspection (codex slice review #4). The script text
 * below is static — nothing user-controlled is interpolated into it.
 */
function dpapiProtect(token: string): string {
  const script = 'Add-Type -AssemblyName System.Security; $s = [Console]::In.ReadToEnd().Trim(); [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($s), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))';
  return runPwsh(script, token);
}

function dpapiUnprotect(stored: string): string {
  const script = 'Add-Type -AssemblyName System.Security; $s = [Console]::In.ReadToEnd().Trim(); [System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))';
  return runPwsh(script, stored);
}

function runPwsh(script: string, stdin: string): string {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15_000, input: stdin });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `pwsh exited ${result.status}`);
  return result.stdout.trim();
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
