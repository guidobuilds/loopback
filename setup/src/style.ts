/**
 * ANSI styling constants for the loopback installer.
 * Visual style matches vercel-labs/skills/src/cli.ts (gradient logo + DIM/TEXT
 * grays that are readable on both light and dark terminals). No frameworks.
 */

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
// 256-color middle grays — darker for secondary text, lighter for primary.
export const DIM = '\x1b[38;5;102m';
export const TEXT = '\x1b[38;5;145m';

/**
 * 256-color gray gradient used to paint the ASCII logo line-by-line.
 * Ordered from lighter (top) to darker (bottom) so the logo appears to fade
 * downward — same direction as the vercel-labs/skills reference.
 */
export const GRAYS: readonly string[] = [
  '\x1b[38;5;250m',
  '\x1b[38;5;248m',
  '\x1b[38;5;245m',
  '\x1b[38;5;243m',
  '\x1b[38;5;240m',
  '\x1b[38;5;238m',
];

/**
 * ASCII logo for "LOOPBACK". 6 lines tall, 73 chars wide (well under 80).
 * Block-letter style matching the vercel-labs/skills aesthetic.
 */
export const LOGO_LINES: readonly string[] = [
  '██╗      ██████╗  ██████╗ ██████╗ ██████╗  █████╗  ██████╗██╗  ██╗',
  '██║     ██╔═══██╗██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██╔════╝██║ ██╔╝',
  '██║     ██║   ██║██║   ██║██████╔╝██████╔╝███████║██║     █████╔╝ ',
  '██║     ██║   ██║██║   ██║██╔═══╝ ██╔══██╗██╔══██║██║     ██╔═██╗ ',
  '███████╗╚██████╔╝╚██████╔╝██║     ██████╔╝██║  ██║╚██████╗██║  ██╗',
  '╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝',
];

/**
 * Paint LOGO_LINES with the GRAYS gradient. Prints a leading and trailing
 * newline so the logo always has breathing room above and below.
 */
export function showLogo(): void {
  console.log();
  LOGO_LINES.forEach((line, i) => {
    const color = GRAYS[Math.min(i, GRAYS.length - 1)];
    console.log(`${color}${line}${RESET}`);
  });
  console.log();
}

/**
 * Show the full banner: logo + tagline + the canonical usage examples + a
 * "try:" line + a learn-more link. Called from `--help` and from a no-args
 * invocation, but only when we are NOT running inside an AI agent.
 */
export function showBanner(): void {
  showLogo();
  console.log(`${DIM}The harness-agnostic feedback loop${RESET}`);
  console.log();
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx @guidobuilds/loopback-setup ${DIM}<agent>${RESET}        ${DIM}Install loopback into an agent${RESET}`
  );
  console.log(
    `  ${DIM}$${RESET} ${TEXT}npx @guidobuilds/loopback-setup --remove${RESET}     ${DIM}Uninstall loopback${RESET}`
  );
  console.log();
  console.log(`${DIM}try:${RESET} npx @guidobuilds/loopback-setup claude-code`);
  console.log();
  console.log(`Learn more at ${TEXT}https://github.com/guidobuilds/loopback${RESET}`);
  console.log();
}
