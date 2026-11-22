// Schema parsing may return arbitrary JavaScript objects before tool input is fixed.
export { isDeepStrictEqual as equalData } from 'node:util';
