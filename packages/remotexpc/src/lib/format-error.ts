import {inspect} from 'node:util';

/** Formats a caught value for log and error messages: `Name: message` for errors, inspected otherwise. */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return typeof err === 'string' ? err : inspect(err);
}

/** Formats an untyped plist/XPC value for messages: primitives as-is, anything else inspected. */
export function formatValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      return inspect(value);
  }
}
