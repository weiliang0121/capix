import { Runner, Resources } from '@weiliang0121/capix-runtime';
import { Group, Scene } from '@weiliang0121/capix-structure';
declare function expectType<Value>(value: Value): void;
type Request = { source: string; destination: string };
declare const sequence: Group<Request, { length: number; destination: string }>;
const root = new Scene<Request, { length: number; destination: string }>().add({ sequence });
root.run = (work) => work.children.sequence.invoke(work.input);
const runner = new Runner(root, new Resources()).build();
expectType<Promise<{ length: number; destination: string }>>(runner.run({ source: 'notes', destination: 'summary' }));
// @ts-expect-error the original request contract reaches the runner
runner.run('wrong');
