/**
 * PowerShell-style argv parsing for parity with pair.ps1: -Flag value pairs,
 * case-insensitive flag names, bare switches, first positional = command.
 */

export type ParsedArgs = {
  command: string;
  flags: Map<string, string | true>;
  positionals: string[];
};

const KNOWN_SWITCHES = new Set(['acceptsharedworktreerisk', 'json', 'nowait']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command = 'help';
  let i = 0;
  if (argv.length > 0 && argv[0] !== undefined && !argv[0].startsWith('-')) {
    command = argv[0].toLowerCase();
    i = 1;
  }
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    const name = token.replace(/^-+/, '').toLowerCase();
    const next = argv[i + 1];
    if (KNOWN_SWITCHES.has(name) || next === undefined || next.startsWith('-')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i++;
    }
  }
  return { command, flags, positionals };
}

export function str(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags.get(name.toLowerCase());
  return typeof v === 'string' ? v : undefined;
}

export function num(flags: ParsedArgs['flags'], name: string, fallback: number): number {
  const v = str(flags, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function has(flags: ParsedArgs['flags'], name: string): boolean {
  return flags.has(name.toLowerCase());
}
