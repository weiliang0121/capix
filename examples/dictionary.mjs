import { Node, Scene, Resources, Runner } from '@capix/server-runtime';
import { Resource, ResourceOffer } from '@capix/resources';

export function createDictionaryRunner(words = new Map([['hello', '你好']])) {
  const dictionary = new Resource(words);
  const lookup = new ResourceOffer({
    methods: {
      translate(entries, word) {
        return entries.get(word) ?? word;
      },
    },
  });
  const translate = new Node({ deps: { dictionary: lookup.request() }, run: (work) => work.resources.dictionary.translate(work.input) });
  const scene = new Scene().add({ translate });
  scene.run = (work) => work.children.translate.invoke(work.input);
  return new Runner(scene, new Resources().register(dictionary, lookup)).build();
}
