import {parseArgs} from 'node:util';

/**
 * Parses CLI args with `util.parseArgs`; prints usage on `-h/--help` (exit 0)
 * or an error plus usage on invalid input (exit 1). Keys are camelCased.
 * `args`/`exit` are injectable for tests.
 * @param {string} usage
 * @param {import('node:util').ParseArgsConfig['options']} options
 * @param {{
 *   maxPositionals?: number,
 *   converters?: Record<string, ((value: string) => unknown) | undefined>,
 *   args?: string[],
 *   exit?: (code: number) => never,
 * }} [opts]
 * @returns {{values: Record<string, any>, positionals: string[]}}
 */
export function parseCliArgs(
  usage,
  options,
  {maxPositionals = 0, converters = {}, args = process.argv.slice(2), exit = (code) => process.exit(code)} = {},
) {
  // Fail fast on a mistyped converter key (programmer error, not a usage error)
  for (const key of Object.keys(converters)) {
    if (!options || !(key in options)) {
      throw new Error(`Converter defined for unknown option '${key}'`);
    }
  }
  /** @type {{values: Record<string, any>, positionals: string[]} | undefined} */
  let parsed;
  try {
    const {values, positionals} = parseArgs({
      args,
      options: {...options, help: {type: 'boolean', short: 'h'}},
      allowPositionals: maxPositionals > 0,
    });
    if (!values.help) {
      if (positionals.length > maxPositionals) {
        throw new Error(`Too many arguments: ${positionals.join(' ')}`);
      }
      /** @type {Record<string, any>} */
      const result = {};
      for (const [key, value] of Object.entries(values)) {
        const converter = converters[key];
        result[toCamelCase(key)] = converter && typeof value === 'string' ? converter(value) : value;
      }
      parsed = {values: result, positionals};
    }
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n${usage}\n`);
    return exit(1);
  }
  if (!parsed) {
    process.stdout.write(`${usage}\n`);
    return exit(0);
  }
  return parsed;
}

/**
 * @param {string} key
 * @returns {string}
 */
function toCamelCase(key) {
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
