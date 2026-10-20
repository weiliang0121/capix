import type { ActiveContentSnapshot } from './active.js';
import type { PreparedConversationContext } from '../group/context/types.js';

/** Messages remain in Transcript; historic memory values are needed by the record detail projection. */
export function describeActiveContent(material: ActiveContentSnapshot) {
  return { basis: material.basis, messageIndexes: material.messages.map((item) => item.index), memories: material.memories };
}

export function describePreparedConversationContext(prepared: PreparedConversationContext) {
  return { material: describeActiveContent(prepared.material), selection: prepared.selection };
}
