/**
 * Stores a dictionary entry as an own property. Plain assignment would hand a `__proto__` key to
 * the prototype setter, so a peer could swap the prototype of a decoded dictionary instead of
 * adding an entry. `__proto__` is the only key with setter semantics on a plain object; any other
 * key, including `constructor`, becomes an own property under plain assignment. Every dictionary
 * built from peer-supplied keys goes through this helper.
 * @param dict - The dictionary being built
 * @param key - The entry's key, as sent by the peer
 * @param value - The entry's value
 */
export function setDictionaryEntry<T>(dict: Record<string, T>, key: string, value: T): void {
  if (key === '__proto__') {
    Object.defineProperty(dict, key, {value, enumerable: true, writable: true, configurable: true});
  } else {
    dict[key] = value;
  }
}
