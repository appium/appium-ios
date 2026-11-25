import {parseArgs} from 'node:util';

/**
 * Parses CLI args with `util.parseArgs`; prints usage on `-h/--help` (exit 0)
 * or an error plus usage on invalid input (exit 1). Keys are camelCased.
 * @param {string} usage
 * @param {import('node:util').ParseArgsConfig['options']} options
 * @param {{maxPositionals?: number, converters?: Record<string, ((value: string) => unknown) | undefined>}} [opts]
 * @returns {{values: Record<string, any>, positionals: string[]}}
 */
export function parseCliArgs(usage, options, {maxPositionals = 0, converters = {}} = {}) {
  try {
    const {values, positionals} = parseArgs({
      options: {...options, help: {type: 'boolean', short: 'h'}},
      allowPositionals: maxPositionals > 0,
    });
    if (values.help) {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }
    if (positionals.length > maxPositionals) {
      throw new Error(`Too many arguments: ${positionals.join(' ')}`);
    }
    /** @type {Record<string, any>} */
    const result = {};
    for (const [key, value] of Object.entries(values)) {
      const converter = converters[key];
      result[toCamelCase(key)] = converter && typeof value === 'string' ? converter(value) : value;
    }
    return {values: result, positionals};
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n${usage}\n`);
    process.exit(1);
  }
}

/**
 * @param {string} key
 * @returns {string}
 */
function toCamelCase(key) {
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
