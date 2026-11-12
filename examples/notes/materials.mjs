import { Notes } from '../entities/domain.mjs';

export const initialValues = [
  { title: '会议记录', text: '整理用户反馈；发送演示链接' },
  { title: '项目计划', text: '检查安装步骤' },
];

export function createMaterials(values = initialValues) {
  const notes = new Notes(); // 仅内存，不落盘，不设置 checkpoint。
  const originals = values.map((value) => notes.append(value));
  const request = {
    messages: [
      { role: 'system', content: '你是便签助手。用 readNote 阅读用户提供的两张便签，整理出三项待办，用 writeNote 创建一张标题为“待办”的新便签。确认写入成功后回答新便签标题和完整内容。不要修改原便签，不要声称保存到磁盘。' },
      { role: 'user', content: JSON.stringify({ task: '读取这两张便签，生成待办便签并回答。', notes: originals.map(({ id, value }) => ({ id, title: value.title })) }) },
    ],
  };
  return { notes, originals, request };
}
