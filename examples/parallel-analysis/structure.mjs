import { Group } from '@weiliang0121/capix-structure';

/** Only this business condition permits an answer without the secondary analysis. */
export class AnalysisUnavailable extends Error {}

export function text(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Comparison requires nonblank text');
  return value;
}

export function delta(value) {
  if (typeof value !== 'string') throw new TypeError('Comparison preview must be text');
  return value;
}

/** A concrete two-material policy, not a generic parallel executor or a scheduler. */
export function createComparisonAnswer({ primary, secondary, merge, indexes }) {
  const positions = Object.freeze({ ...indexes });
  if (![positions.primary, positions.secondary].every((index) => Number.isSafeInteger(index) && index >= 0) || positions.primary === positions.secondary) throw new TypeError('Select two distinct formal message indexes');
  const answer = new Group({ name: 'compare-materials', output: { result: text, delta } }).add({ primary, secondary, merge });

  answer.run = async (work) => {
    // Select both from one captured View before starting either branch. These are
    // fixed input values, not resource grants or hidden access to another branch.
    const first = material(work.input, positions.primary);
    const second = material(work.input, positions.secondary);
    const query = work.input.query;
    const [primaryResult, secondaryResult] = await Promise.all([
      work.children.primary.invoke({ query, material: first }, { result: { succeeded: (value) => accepted(first, value) } }),
      work.children.secondary.invoke(
        { query, material: second },
        {
          result: {
            succeeded: (value) => accepted(second, value),
            failed(error) {
              if (!(error instanceof AnalysisUnavailable)) throw error;
              return Object.freeze({ status: 'unavailable', material: second, reason: error.message });
            },
          },
        },
      ),
    ]);
    // Promise.all preserves input positions, not completion order. Only the
    // merger's preview becomes the conversation preview; branch output is local.
    return work.children.merge.invoke({ query, primary: primaryResult, secondary: secondaryResult }, { delta: (value) => work.output.emit(value) });
  };
  return answer;
}

function material(input, index) {
  const source = input.materials.basis.sources.messages;
  const entry = input.materials.entries.find((entry) => entry.source === 'messages' && entry.key === index);
  if (source.id !== input.query.transcriptId || index >= input.query.index || !entry) throw new Error('Selected prior message is not in the fixed material view');
  return Object.freeze({ transcriptId: source.id, index, content: text(entry.value.content) });
}

function accepted(material, value) {
  return Object.freeze({ status: 'available', material, analysis: text(value) });
}
