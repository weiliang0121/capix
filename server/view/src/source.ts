/** Identity of the content source and the exact range installed in this endpoint. */
export interface SourceIdentity {
  readonly id: string;
  readonly scope: string;
}

/** The source owns version meaning; it must cover membership and content changes. */
export interface SourceStamp extends SourceIdentity {
  readonly version: string;
}

export type ViewKey = string | number;
export type Awaitable<Value> = Value | PromiseLike<Value>;
export interface SourceIndex<Key extends ViewKey, Summary> {
  readonly stamp: SourceStamp;
  /** Complete directory for this source scope; never a partial page. */
  readonly entries: readonly { readonly key: Key; readonly summary: Summary }[];
}
/** Exactly the requested keys, validated with their summaries at one source version. */
export interface SourceInspection<Key extends ViewKey, Summary> {
  readonly stamp: SourceStamp;
  readonly entries: readonly { readonly key: Key; readonly summary: Summary }[];
}
export interface SourceSnapshot<Key extends ViewKey, Value> {
  readonly stamp: SourceStamp;
  readonly entries: readonly { readonly key: Key; readonly value: Value }[];
}

/** A read contract. Version validation and value capture happen together inside read. */
export interface ViewSource<Key extends ViewKey, Summary, Value> {
  index(): Awaitable<SourceIndex<Key, Summary>>;
  inspect(keys: readonly Key[]): Awaitable<SourceInspection<Key, Summary>>;
  read(keys: readonly Key[], expected: SourceStamp): Awaitable<SourceSnapshot<Key, Value>>;
  check(expected: SourceStamp): Awaitable<boolean>;
}
export interface SyncViewSource<Key extends ViewKey, Summary, Value> extends ViewSource<Key, Summary, Value> {
  index(): SourceIndex<Key, Summary>;
  inspect(keys: readonly Key[]): SourceInspection<Key, Summary>;
  read(keys: readonly Key[], expected: SourceStamp): SourceSnapshot<Key, Value>;
  check(expected: SourceStamp): boolean;
}

export type ViewSources = Readonly<Record<string, ViewSource<any, any, any>>>;
export type SyncViewSources = Readonly<Record<string, SyncViewSource<any, any, any>>>;
export type SourceKey<Source> = Source extends ViewSource<infer Key, any, any> ? Key : never;
export type SourceSummary<Source> = Source extends ViewSource<any, infer Summary, any> ? Summary : never;
export type SourceValue<Source> = Source extends ViewSource<any, any, infer Value> ? Value : never;

/** Source slots describe their data contracts, not the concrete adapter classes. */
export type SourceBindings<Sources extends ViewSources> = {
  readonly [Name in keyof Sources]: ViewSource<SourceKey<Sources[Name]>, SourceSummary<Sources[Name]>, SourceValue<Sources[Name]>>;
};
export type SyncSourceBindings<Sources extends ViewSources> = {
  readonly [Name in keyof Sources]: SyncViewSource<SourceKey<Sources[Name]>, SourceSummary<Sources[Name]>, SourceValue<Sources[Name]>>;
};
