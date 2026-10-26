/** Capture completed source facts, transfer pending batches and publish to passive consumers. */
export type { ChangeCapture } from './capture.js';
export { ChangeBuffer } from './buffer.js';
export { ChangeCaptureError, combineFaults } from './error.js';
export { captureChange, publishFact, type ChangeProvenance } from './publish.js';
export type { EventConsumer } from './consumer.js';
export { ProgressChannel, type ProgressFailure, type ProgressReceiver } from './progress.js';
