import { Runner, Resources } from '@weiliang0121/capix-runtime';
import { Group, Scene } from '@weiliang0121/capix-structure';
declare function expectType<Value>(value: Value): void;
declare const dynamic: Group<{ request: string }, { saved: number }>;
const scene = new Scene<{ request: string }, { saved: number }>().add({ dynamic });
scene.run = (work) => work.children.dynamic.invoke(work.input);
expectType<Promise<{ saved: number }>>(new Runner(scene, new Resources()).build().run({ request: 'save' }));
