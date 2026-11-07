import { writeSync } from 'node:fs';
import { openStudy } from './store.mjs';
import { buildScenario } from './scenario.mjs';

const [action, directory, mode = 'explicit', encodedOptions = '{}'] = process.argv.slice(2);
if (!['run', 'resume', 'inspect'].includes(action) || !['explicit', 'replay'].includes(mode) || !directory) throw new Error('Use: process.mjs run|resume|inspect DIRECTORY explicit|replay [JSON options]');
const options = JSON.parse(encodedOptions);
const study = openStudy(directory, options);
const print = (extra) => writeSync(1, `${JSON.stringify(study.report({ pid: process.pid, action, mode, ...extra }))}\n`);
const cut = (position) => {
  if (options.cut !== position) return;
  study.event('cut', { position });
  print({ status: 'halted', cut: position });
  process.exit(73); // Real loss: bypasses catch, finally and all runtime cleanup.
};
try {
  if (action === 'inspect') print({ status: 'inspected' });
  else {
    const head = study.heads().scene;
    const { runner, probeClosed } = buildScenario(study, mode, options, cut);
    try {
      if (action === 'resume' && !head) throw new Error('No saved root');
      const result = action === 'run' ? await runner.run({ query: 'one', material: study.source() }) : await runner.resume(head.image.frame.owner.contextId);
      await probeClosed();
      print({ status: 'succeeded', result });
    } catch (error) {
      await probeClosed();
      print({ status: 'failed', error: { name: error?.name, code: error?.code, message: error?.message } });
      process.exitCode = 1;
    }
  }
} catch (error) {
  print({ status: 'failed', error: { name: error?.name, code: error?.code, message: error?.message } });
  process.exitCode = 1;
} finally {
  study.close();
}
