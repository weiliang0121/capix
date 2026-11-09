import { Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';

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
  const scene = new Scene(translate);
  return new Runner(scene, new Resources().register(dictionary, lookup)).build();
}
