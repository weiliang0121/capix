import { CompletionResource, ConversationViewResource, createConversationScene, createMaterialPreparation } from '@capix/conversation-service';
import { ConversationRecording } from '@capix/conversation-service/recording';
import { Memories } from '@capix/memory';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';
import { View } from '@capix/view';
import { createComparisonAnswer } from './structure.mjs';
import { createAnalysisGroup, createMergeGroup } from './model.mjs';

/** In-memory experiment host. It never opens the user's DB or replaces Web wiring. */
export function createComparisonExample({ model, primary = createAnalysisGroup('analyze-primary'), secondary = createAnalysisGroup('analyze-secondary'), merge = createMergeGroup(), recording: enabled = false, transcriptPersistence } = {}) {
  const transcript = new Transcript(
    [
      { role: 'user', content: '方案 A：周五发布，周四完成复核；依赖现有团队，需要压缩测试时间。' },
      { role: 'assistant', content: '已收到方案 A。' },
      { role: 'user', content: '方案 B：下周二发布，保留完整测试时间；需要协调另一团队的联调窗口。' },
    ],
    { persistence: transcriptPersistence },
  );
  const memories = new Memories(transcript);
  const view = new View({
    revision: 0,
    sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } },
    members: [
      { source: 'messages', key: 0 },
      { source: 'messages', key: 2 },
    ],
  });
  const content = { transcript, memories, view };
  const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(new Resource(content), ConversationViewResource.read);
  if (model) resources.register(new Resource(model), CompletionResource);
  const answer = createComparisonAnswer({ primary, secondary, merge, indexes: { primary: 0, secondary: 2 } });
  const scene = createConversationScene(answer, createMaterialPreparation());
  const recording = new ConversationRecording(scene);
  const runner = new Runner(scene, resources, undefined, { observations: [recording] }).build();
  if (enabled) recording.start();
  return { runner, content, recording };
}
