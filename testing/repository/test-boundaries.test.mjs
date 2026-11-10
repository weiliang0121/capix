import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { discover, root, workspacePackages } from '../../scripts/test/discovery.mjs';

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sources(path)));
    else if (/\.(?:mjs|ts)$/.test(entry.name)) result.push(path);
  }
  return result;
}

function imports(source) {
  const result = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true));
  return result;
}

test('dependency scanning includes type imports without treating negative consumer strings as dependencies', () => {
  assert.deepEqual(imports(`import { Value } from 'one'; export type { Other } from 'two'; const module = import('three'); type V = import('four').Value; const rejectedConsumer = "import { Forbidden } from 'not-installed'";`), ['one', 'two', 'three', 'four']);
});

function inside(directory, path) {
  const value = relative(directory, path);
  return value === '' || (!value.startsWith('..') && !value.startsWith('/'));
}

test('every package owns discoverable tests and declares their public framework dependencies without cycles', async () => {
  const entries = await workspacePackages();
  const manifests = new Map(entries.map(({ manifest }) => [manifest.name, manifest]));
  const groups = await discover('packages');
  assert.deepEqual(
    groups.map(({ name }) => name),
    entries.map(({ manifest }) => manifest.name),
  );
  assert.equal(
    new Set(groups.flatMap(({ files }) => files)).size,
    groups.reduce((count, group) => count + group.files.length, 0),
  );
  const edges = new Map();
  for (const { directory, manifest } of entries) {
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
    edges.set(
      manifest.name,
      Object.keys(dependencies).filter((name) => manifests.has(name)),
    );
    for (const file of await sources(join(directory, 'test'))) {
      for (const specifier of imports(await readFile(file, 'utf8'))) {
        if (specifier.startsWith('@weiliang0121/capix-') || specifier.startsWith('@capix/')) {
          const [scope, name, ...rest] = specifier.split('/');
          const packageName = `${scope}/${name}`;
          assert.ok(manifests.has(packageName), `${relative(root, file)} imports unknown package ${packageName}`);
          assert.ok(packageName === manifest.name || dependencies[packageName], `${relative(root, file)} must declare ${packageName} in its owning package`);
          assert.ok(manifests.get(packageName).exports[rest.length ? `./${rest.join('/')}` : '.'], `${relative(root, file)} imports a private package path: ${specifier}`);
        } else if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          assert.ok(inside(directory, target) || inside(join(root, 'testing/support'), target) || inside(join(root, 'examples'), target), `${relative(root, file)} imports another package's test or private implementation: ${specifier}`);
        }
      }
    }
  }
  const completed = new Set();
  function visit(name, ancestors) {
    assert.ok(!ancestors.includes(name), `Test dependency cycle: ${[...ancestors, name].join(' -> ')}`);
    if (completed.has(name)) return;
    for (const child of edges.get(name)) visit(child, [...ancestors, name]);
    completed.add(name);
  }
  for (const name of edges.keys()) visit(name, []);
});

test('shared testing support contains tools, not hidden framework assembly', async () => {
  for (const file of await sources(join(root, 'testing/support'))) {
    for (const specifier of imports(await readFile(file, 'utf8'))) {
      assert.ok(!specifier.startsWith('@capix/') && !specifier.startsWith('@weiliang0121/capix-'), `${file} must not assemble framework objects`);
      if (specifier.startsWith('.')) assert.ok(inside(join(root, 'testing/support'), resolve(dirname(file), specifier)), `${file} escapes shared support`);
    }
  }
});
