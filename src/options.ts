/** Checking the options given on the command line (CLI 0.11.5). */

/** The options each command takes, besides those every command takes. */
const COMMAND_OPTIONS: Record<string, readonly string[]> = { send: ["to"], text: ["to"], receive: ["to", "from", "yes"], pair: [], devices: [], forget: [], mcp: [] };
const EVERY_COMMAND = ["name", "agent", "ephemeral", "help", "version"];
const WITH_VALUE = ["to", "from", "name"];
/**
 * What is wrong with the options given, if anything: one the command does not take (a typo must not pass unnoticed), or
 * one that needs a value given none (a bare --to must not fall back to the only device) (CLI 0.11.5, B20).
 */
export function wrongOption(command: string, flags: Record<string, string | true>): string | undefined {
  const known = COMMAND_OPTIONS[command];
  for (const [flag, value] of Object.entries(flags)) {
    if (known && !EVERY_COMMAND.includes(flag) && !known.includes(flag)) return `"${command}" has no option --${flag}.`;
    if (WITH_VALUE.includes(flag) && (value === true || !value.trim())) return `--${flag} needs a value.`;
  }
  return undefined;
}
