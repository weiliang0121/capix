import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { discover, requireBuild, root, workspacePackages } from './discovery.mjs';

function command(executable, args, cwd) {
  const child = spawnSync(executable, args, { cwd, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}

try {
  const args = process.argv.slice(2);
  const option = args.shift();
  if (!['--packages', '--repository', '--package'].includes(option)) throw new Error('Expected --packages, --repository or --package <directory>');
  const mode = option.slice(2);
  const directory = mode === 'package' ? resolve(args.shift() ?? '.') : undefined;
  const list = args.length === 1 && args[0] === '--list';
  if (args.length && !list) throw new Error(`Unexpected arguments: ${args.join(' ')}`);
  const groups = await discover(mode, directory);
  if (list) {
    console.log(
      JSON.stringify(
        groups.map(({ name, files }) => ({ name, files: files.map((file) => relative(root, file)) })),
        null,
        2,
      ),
    );
  } else {
    if (mode === 'package') command('pnpm', ['--filter', `${groups[0].name}...`, '--fail-if-no-match', 'build'], root);
    await requireBuild(mode === 'repository' ? await workspacePackages() : groups);
    const files = groups.flatMap((group) => group.files);
    console.log(`Running ${files.length} test files in ${groups.length} ${mode === 'repository' ? 'repository group' : 'package(s)'}`);
    command(process.execPath, ['--test', ...files], directory ?? root);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
