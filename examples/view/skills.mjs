import { randomUUID } from 'node:crypto';
import { createViewSource } from '@weiliang0121/capix-view';

// 示例自己的静态 Skill 来源，不是框架新增的 Skill 实体或注册平台。
// 内容构造后不变，因此版本固定；可变来源必须在成员/正文变化时换版本。
export function createSkillSource() {
  const values = new Map([['translate', Object.freeze({ instructions: '把输入翻译为中文；遵循材料中的用户偏好。' })]]);
  const requireSkill = (key) => {
    if (!values.has(key)) throw new RangeError('Skill does not exist in this source scope');
    return values.get(key);
  };
  return createViewSource({
    id: randomUUID(),
    scope: 'whole',
    version: () => '1',
    keys: () => [...values.keys()],
    inspect(key) {
      requireSkill(key);
      return { title: '中文翻译' };
    },
    read: requireSkill,
  });
}
