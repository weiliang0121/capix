import { runConversationCli } from './cli/run.js';

try {
  process.exitCode = await runConversationCli(process.argv.slice(2));
} catch (error) {
  // Host argument/configuration/store diagnostics, without stack or arbitrary nested causes.
  console.error(error instanceof Error ? error.message : 'Conversation service failed');
  process.exitCode = 1;
}
