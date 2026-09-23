/** Accepted output of the Observer generation operation. */
export interface GenerationOutput {
  kind: 'answer' | 'unknown' | 'needs-info';
  content: string;
}
