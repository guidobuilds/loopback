import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BOLD, DIM, RESET, TEXT, showBanner } from './style.js';
import { isRunningInAgent } from './detect-agent.js';
import { runInstall } from './install.js';
import { runRemove } from './remove.js';

/**
 * Parsed-args shape shared by install.ts and remove.ts.
 * Kept in this file (not a separate args.ts) — there's exactly one parse site
 * and two consumers, so a local export is the lightest surface.
 */
export interface ParsedArgs {
  agent: string | undefined;
  remove: boolean;
  token: string | undefined;
  serviceUrl: string | undefined;
  yes: boolean;
  force: boolean;
  all: boolean;
  rawArgs: string[];
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  remove: { type: 'boolean', short: 'r' },
  token: { type: 'string' },
  'service-url': { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
  all: { type: 'boolean' },
} as const;

function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../package.json (sibling of dist/)
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function showHelp(): void {
  // The banner already includes the canonical usage examples + a "try:" line
  // + the learn-more link. Append a detailed options table + EXAMPLES section
  // here so `--help` is the authoritative reference.
  if (!isRunningInAgent()) {
    showBanner();
  } else {
    // In-agent: skip the ASCII logo but still print the textual usage.
    console.log(`${DIM}The harness-agnostic feedback loop${RESET}`);
    console.log();
    console.log(`  ${DIM}$${RESET} ${TEXT}npx @guidobuilds/loopback-setup <agent>${RESET}`);
    console.log(`  ${DIM}$${RESET} ${TEXT}npx @guidobuilds/loopback-setup --remove${RESET}`);
    console.log();
  }

  console.log(`${BOLD}Usage:${RESET} npx @guidobuilds/loopback-setup [agent] [options]`);
  console.log();
  console.log(`${BOLD}Arguments:${RESET}`);
  console.log(`  agent                 ${DIM}claude-code | opencode | codex${RESET}`);
  console.log();
  console.log(`${BOLD}Options:${RESET}`);
  console.log(`  --token <T>           ${DIM}Override token (skip auth prompt)${RESET}`);
  console.log(`  --service-url <U>     ${DIM}Override service URL (skip auth prompt)${RESET}`);
  console.log(`  -y, --yes             ${DIM}Skip all prompts (take defaults)${RESET}`);
  console.log(`      --force           ${DIM}Reinstall even if already installed${RESET}`);
  console.log(`  -r, --remove          ${DIM}Uninstall mode${RESET}`);
  console.log(`      --all             ${DIM}With --remove: also delete ~/.loopback/${RESET}`);
  console.log(`  -h, --help            ${DIM}Show this help${RESET}`);
  console.log(`  -v, --version         ${DIM}Show version${RESET}`);
  console.log();
  console.log(`${BOLD}EXAMPLES:${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}npx @guidobuilds/loopback-setup${RESET}                              ${DIM}# interactive wizard${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}npx @guidobuilds/loopback-setup claude-code${RESET}                  ${DIM}# install into Claude Code${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}npx @guidobuilds/loopback-setup claude-code --token T --yes${RESET}  ${DIM}# non-interactive${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}npx @guidobuilds/loopback-setup --remove claude-code${RESET}         ${DIM}# uninstall${RESET}`);
  console.log();
  console.log(`Learn more at ${TEXT}https://github.com/guidobuilds/loopback${RESET}`);
  console.log();
}

function parseArgv(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${BOLD}Error:${RESET} ${msg}\n`);
    process.exit(2);
  }
  const v = parsed.values as Record<string, string | boolean | undefined>;
  return {
    agent: parsed.positionals[0],
    remove: Boolean(v.remove),
    token: typeof v.token === 'string' ? v.token : undefined,
    serviceUrl: typeof v['service-url'] === 'string' ? (v['service-url'] as string) : undefined,
    yes: Boolean(v.yes),
    force: Boolean(v.force),
    all: Boolean(v.all),
    rawArgs: argv,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Short-circuit help/version BEFORE strict parseArgs runs, so an invocation
  // like `--help --remove` is still treated as help (parseArgs would accept
  // both, but this also keeps behavior predictable if we add more flags).
  // We still parse for help/version with the same options so unknown flags
  // are rejected uniformly.
  const args = parseArgv(argv);

  // Re-derive help/version flags from the raw argv since ParsedArgs doesn't
  // surface them (they're not consumed by install/remove).
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const wantsVersion = argv.includes('--version') || argv.includes('-v');

  if (wantsVersion) {
    console.log(getVersion());
    process.exit(0);
  }

  if (wantsHelp) {
    showHelp();
    process.exit(0);
  }

  if (args.remove) {
    await runRemove(args);
    return;
  }

  await runInstall(args);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${BOLD}Error:${RESET} ${msg}\n`);
  process.exit(1);
});
