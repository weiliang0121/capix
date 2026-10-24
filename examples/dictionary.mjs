import { Node, Scene, Resource, ResourceOffer, Resources, Runner } from '@capix/server-runtime';

export function createDictionaryRunner(words = new Map([['hello', '你好']])) {
  const dictionary = new Resource(words);
  const lookup = new ResourceOffer({
    methods: {
      translate(entries, word) {
        return entries.get(word) ?? word;
      },
    },
  });
  const translate = new Node().setRun((work) => work.resources.dictionary.translate(work.input), { dictionary: lookup.request() });
  const scene = new Scene().add({ translate }).setRun((work) => work.children.translate.invoke(work.input));
  return new Runner(scene, new Resources().register(dictionary, lookup)).build();
}
