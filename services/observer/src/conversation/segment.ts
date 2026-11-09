import { TranscriptRangeReader } from '@weiliang0121/capix-transcript';
import { groupAdjacentPairs } from '@weiliang0121/capix-transcript/presets';

/** Retain up to two consecutive user/assistant pairs immediately before this input. */
export function segmentCandidates(range: TranscriptRangeReader): readonly TranscriptRangeReader[] {
  if (!range.length) return [];
  const starts = [range.end - 1];
  // The two-pair retention limit belongs to this service; the preset only groups messages.
  const history = range.slice(Math.max(range.start, range.end - 5), range.end - 1);
  const groups = groupAdjacentPairs(history.entries());
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    if (group.length !== 2) break;
    starts.unshift(group[0].index);
  }
  // Never reopen archived messages or create another segment at the same boundary.
  return starts.filter((candidate) => candidate > range.start).map((candidate) => range.slice(candidate));
}
