import { equalData as compare } from '#data-equality';

/** Compare fixed acyclic data. Node retains its native comparison of schema results. */
export function equalData(left: unknown, right: unknown): boolean {
  return compare(left, right);
}
