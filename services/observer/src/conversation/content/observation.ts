import type { ActiveViewSnapshot } from '@capix/observer-content';
import type { PreparedConversationContext } from '../group/context/types.js';

/** Messages remain in Transcript; historic memory values are needed by the record detail projection. */
export function describeActiveView(material: ActiveViewSnapshot) {
  return { basis: material.basis, messageIndexes: material.messages.map((item) => item.index), memories: material.memories };
}

export function describePreparedConversationContext(prepared: PreparedConversationContext) {
  return { material: describeActiveView(prepared.material), selection: prepared.selection };
}
