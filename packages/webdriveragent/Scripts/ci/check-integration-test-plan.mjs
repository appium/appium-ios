#!/usr/bin/env node
// Verifies integration-test-plan.json against the Xcode project: every iPhone test class runs
// in exactly one chunk, in the bundle (scheme) that compiles it. An unknown class/bundle pair
// makes xcodebuild run 0 tests and still pass, so this guards against silently dropped tests.
// The iPad job's tests are declared in the test sources by the `+iPadTests` class methods of
// FBIntegrationTestCase subclasses (literal `return @[@"testName", ...]`, @"*" = whole class).
// Usage: check-integration-test-plan.mjs [--dump | --ipad-plan]
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const TESTS_DIR = path.join(ROOT, 'WebDriverAgentTests/IntegrationTests');
const BUNDLES = ['IntegrationTests_1', 'IntegrationTests_2', 'IntegrationTests_3'];

const pbxproj = readFileSync(path.join(ROOT, 'WebDriverAgent.xcodeproj/project.pbxproj'), 'utf8');

/** Source file names compiled into a bundle, from its Sources build phase. */
function bundleSources(bundle) {
  const target = pbxproj.match(new RegExp(`/\\* ${bundle} \\*/ = \\{\\s*isa = PBXNativeTarget;[\\s\\S]*?buildPhases = \\(([\\s\\S]*?)\\);`));
  const phaseId = target?.[1].match(/(\w{24}) \/\* Sources \*\//)?.[1];
  const phase = phaseId && pbxproj.match(new RegExp(`${phaseId} /\\* Sources \\*/ = \\{[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`));
  if (!phase) {
    throw new Error(`Cannot find the Sources phase of ${bundle}`);
  }
  return [...phase[1].matchAll(/\/\* ([^*]+?) in Sources \*\//g)].map((m) => m[1]);
}

/** class name -> {superclass, tests: own test method names, ipad: +iPadTests entries} for a file. */
function parseClasses(source) {
  const classes = {};
  for (const m of source.matchAll(/@interface\s+(\w+)\s*:\s*(\w+)/g)) {
    classes[m[1]] = {superclass: m[2], tests: new Set(), ipad: []};
  }
  for (const m of source.matchAll(/@implementation\s+(\w+)\b([\s\S]*?)@end/g)) {
    const cls = (classes[m[1]] ??= {superclass: null, tests: new Set(), ipad: []});
    if (/\+\s*\(NSArray<NSString \*> \*\)iPadTests/.test(m[2])) {
      const literal = m[2].match(/\)iPadTests\s*\{\s*return\s*@\[([^\]]*)\];/);
      if (!literal) {
        throw new Error(`${m[1]}: +iPadTests must be a literal \`return @[@"testName", ...];\``);
      }
      cls.ipad = [...literal[1].matchAll(/@"([^"]*)"/g)].map((s) => s[1]);
    }
    for (const t of m[2].matchAll(/^- \(void\)(test\w+)\s*(?:\{.*)?$/gm)) {
      cls.tests.add(t[1]);
    }
  }
  return classes;
}

const bundles = {}; // bundle -> {class -> Set(test methods incl. inherited)}
const ipadTests = {}; // bundle -> [Class | Class/test] declared by +iPadTests
for (const bundle of BUNDLES) {
  const all = {};
  for (const file of bundleSources(bundle).filter((f) => f.endsWith('.m'))) {
    try {
      Object.assign(all, parseClasses(readFileSync(path.join(TESTS_DIR, file), 'utf8')));
    } catch {
      // not an integration test source (e.g. app code compiled in the bundle)
    }
  }
  const tests = (name, seen = new Set()) => {
    const cls = all[name];
    if (!cls || seen.has(name)) {
      return new Set();
    }
    seen.add(name);
    return new Set([...cls.tests, ...(cls.superclass ? tests(cls.superclass, seen) : [])]);
  };
  bundles[bundle] = Object.fromEntries(
    Object.keys(all).map((name) => [name, tests(name)]).filter(([, t]) => t.size > 0),
  );
  ipadTests[bundle] = Object.entries(all)
    .filter(([name, cls]) => cls.ipad.length > 0 && bundles[bundle][name])
    .flatMap(([name, cls]) => cls.ipad.map((test) => (test === '*' ? name : `${name}/${test}`)));
}

if (process.argv.includes('--dump')) {
  console.log(JSON.stringify(Object.fromEntries(Object.entries(bundles).map(([b, c]) =>
    [b, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.size]))])), null, 1));
  process.exit(0);
}

if (process.argv.includes('--ipad-plan')) {
  console.log(JSON.stringify(Object.fromEntries(Object.entries(ipadTests).filter(([, items]) => items.length))));
  process.exit(0);
}

const plan = JSON.parse(readFileSync(path.join(HERE, 'integration-test-plan.json'), 'utf8'));
const errors = [];
const check = (bundle, item, where) => {
  const [cls, method] = item.split('/');
  const tests = bundles[bundle]?.[cls];
  if (!tests) {
    errors.push(`${where}: ${bundle} has no test class ${cls}`);
  } else if (method && !tests.has(method)) {
    errors.push(`${where}: ${cls} has no test ${method}`);
  }
};

const assigned = new Map(); // "bundle/class" -> chunk index
plan.iphone.forEach((chunk, i) => {
  for (const [bundle, items] of Object.entries(chunk)) {
    for (const item of items) {
      check(bundle, item, `iphone chunk ${i + 1}`);
      if (item.includes('/')) {
        errors.push(`iphone chunk ${i + 1}: ${item} must be a whole class`);
      }
      const key = `${bundle}/${item}`;
      if (assigned.has(key)) {
        errors.push(`${key} is in iphone chunks ${assigned.get(key)} and ${i + 1}`);
      }
      assigned.set(key, i + 1);
    }
  }
});
for (const [bundle, classes] of Object.entries(bundles)) {
  for (const cls of Object.keys(classes)) {
    if (!assigned.has(`${bundle}/${cls}`)) {
      errors.push(`${bundle}/${cls} is not assigned to any iphone chunk`);
    }
  }
}
for (const [bundle, items] of Object.entries(ipadTests)) {
  items.forEach((item) => check(bundle, item, '+iPadTests'));
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Integration test plan OK: ${assigned.size} classes in ${plan.iphone.length} iphone chunks`);
