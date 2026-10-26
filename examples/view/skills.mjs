import { randomUUID } from 'node:crypto';
import { RuntimeError } from '@capix/contracts';

// 示例自己的静态 Skill 来源，不是框架新增的 Skill 实体或注册平台。
// 内容构造后不变，因此版本固定；可变来源必须在成员/正文变化时换版本。
export function createSkillSource() {
  const stamp = Object.freeze({ id: randomUUID(), scope: 'whole', version: '1' });
  const skill = Object.freeze({ instructions: '把输入翻译为中文；遵循材料中的用户偏好。' });
  const values = new Map([['translate', skill]]);
  const directory = Object.freeze({ stamp, entries: Object.freeze([Object.freeze({ key: 'translate', summary: Object.freeze({ title: '中文翻译' }) })]) });
  const check = (expected) => expected?.id === stamp.id && expected.scope === stamp.scope && expected.version === stamp.version;

  return Object.freeze({
    id: stamp.id,
    scope: stamp.scope,
    index() {
      // 目录只有摘要；不把 Skill 正文混入目录。
      return directory;
    },
    read(keys, expected) {
      // 版本核验和取值属于来源的职责。缺项不能静默略过。
      if (!check(expected)) throw new RuntimeError('VIEW_SOURCE_CONFLICT', 'Skill 来源依据已变化');
      if (new Set(keys).size !== keys.length) throw new TypeError('Skill keys must be unique');
      return {
        stamp,
        entries: keys.map((key) => {
          if (!values.has(key)) throw new RangeError('Skill does not exist in this source scope');
          return { key, value: values.get(key) };
        }),
      };
    },
    check,
  });
}
