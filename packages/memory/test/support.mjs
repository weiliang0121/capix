export const create = (content, metadata) => ({ action: 'create', value: { content, ...(metadata === undefined ? {} : { metadata }) } });
export const update = (id, content, metadata) => ({ ...create(content, metadata), action: 'update', memoryId: id });
export const fixed = (memories, changes, options = {}) => ({ contract: { key: 'memories.apply', version: 2 }, contentContract: memories.contentContract, memoriesId: memories.id, operation: { contextId: 'memory-test-call' }, command: { position: 'remember', changes }, ...options });
