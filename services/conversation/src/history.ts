import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { Transcript } from '@weiliang0121/capix-transcript';

/** This service uses the complete prefix ending at its accepted input, without selection or trimming. */
export const HistoryResource = new ResourceOffer({
  name: 'conversation.history',
  methods: {
    read(transcript: Transcript, end: number) {
      return Object.freeze(transcript.snapshot(end));
    },
  },
  observation: {
    source: (transcript) => ({ transcriptId: transcript.id }),
    methods: { read: { input: (end) => ({ end }), output: (messages) => ({ count: messages.length }) } },
  },
});
