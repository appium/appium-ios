import {inspect} from 'node:util';

/**
 * Formats a caught value for log messages: `Name: message` for errors, inspected otherwise.
 * @param {unknown} err
 * @returns {string}
 */
export function formatError(err) {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return typeof err === 'string' ? err : inspect(err);
}
