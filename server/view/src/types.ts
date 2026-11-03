import type { SourceIdentity, SourceKey, SourceStamp, SourceSummary, SourceValue, ViewSources } from './source.js';

export type ViewReference<Sources extends ViewSources> = { [Name in keyof Sources & string]: { readonly source: Name; readonly key: SourceKey<Sources[Name]> } }[keyof Sources & string];
export type ViewIndexEntry<Sources extends ViewSources> = { [Name in keyof Sources & string]: { readonly source: Name; readonly key: SourceKey<Sources[Name]>; readonly summary: SourceSummary<Sources[Name]> } }[keyof Sources & string];
export type ViewEntry<Sources extends ViewSources> = { [Name in keyof Sources & string]: { readonly source: Name; readonly key: SourceKey<Sources[Name]>; readonly value: SourceValue<Sources[Name]> } }[keyof Sources & string];

/** Long-lived membership only; contains neither live endpoints nor cached content. */
export interface ViewState<Sources extends ViewSources> {
  readonly revision: number;
  readonly sources: { readonly [Name in keyof Sources]: SourceIdentity };
  readonly members: readonly ViewReference<Sources>[];
}
export interface ViewBasis<Sources extends ViewSources> {
  readonly viewRevision: number;
  readonly sources: { readonly [Name in keyof Sources]: SourceStamp };
}
export interface ViewIndex<Sources extends ViewSources> {
  readonly basis: ViewBasis<Sources>;
  readonly members: readonly ViewReference<Sources>[];
  readonly entries: readonly ViewIndexEntry<Sources>[];
}
export interface ViewSnapshot<Sources extends ViewSources> {
  readonly basis: ViewBasis<Sources>;
  readonly entries: readonly ViewEntry<Sources>[];
}
export interface ViewSelection<Sources extends ViewSources> {
  readonly basis: ViewBasis<Sources>;
  readonly members: readonly ViewReference<Sources>[];
}
export interface ViewCommit<Sources extends ViewSources> {
  /** Only sources actually verified by this mutation; empty for membership removal. */
  readonly checkedSources: ViewSourceChecks<Sources>;
  /** Persistence must compare this revision before committing the next state. */
  readonly previous: ViewState<Sources>;
  readonly state: ViewState<Sources>;
}
export type ViewSourceChecks<Sources extends ViewSources> = { readonly [Name in keyof Sources]?: SourceStamp };
/** Host-owned atomic validation and persistence; the view does not coordinate external transactions. */
export interface ViewPersistence<Sources extends ViewSources> {
  commit(change: ViewCommit<Sources>): undefined;
}
