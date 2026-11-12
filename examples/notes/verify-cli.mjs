import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { main } from '../notes-assistant.mjs';

export async function verifyNotesCli() {
  const names = ['MODEL_ENDPOINT', 'MODEL_NAME', 'MODEL_API_KEY'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const output = [];
  let sends = 0;
  try {
    // 仅在这个串行检查中安装哨兵；finally 恢复环境、fetch 和输出。
    process.env.MODEL_ENDPOINT = 'https://never-called.example/v1/chat/completions';
    process.env.MODEL_NAME = 'never-used-model';
    process.env.MODEL_API_KEY = 'example-sentinel-key';
    globalThis.fetch = async () => {
      sends++;
      throw new Error('Network forbidden during CLI checks');
    };
    console.log = (...values) => output.push(values.join(' '));

    await main([]); // 即使 MODEL_* 齐全，默认入口仍是离线脚本。
    assert.match(output[0], /离线模式/u);
    assert.equal(output.filter((line) => line.startsWith('readNote 成功')).length, 2);
    assert.equal(output.filter((line) => line.startsWith('writeNote 成功')).length, 1);
    assert.ok(!output.join('\n').includes('example-sentinel-key'));
    output.length = 0;
    await main(['--help']);
    assert.equal(output.length, 1);
    assert.match(output[0], /用法/u);
    for (const args of [['--unknown'], ['--help', '--live'], ['--live', '--unknown']]) await assert.rejects(main(args), /参数只支持/u);

    for (const name of names) {
      const value = process.env[name];
      delete process.env[name];
      await assert.rejects(main(['--live']), (error) => {
        assert.match(error.message, /必须提供 MODEL_ENDPOINT、MODEL_NAME、MODEL_API_KEY/u);
        assert.ok(!error.message.includes('example-sentinel-key'));
        return true;
      });
      process.env[name] = value;
    }
    assert.equal(sends, 0, 'Default, help, invalid arguments and missing live configuration must never send');
    assert.ok(!output.join('\n').includes('example-sentinel-key'));
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
  console.log('便签 CLI 验证通过：默认离线、帮助、非法参数、缺配置均不触网。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyNotesCli();
