/** Short exploratory samples, not a production SLA or a long-running soak test. */
export function serverCapacityPlan({ workers = [1, 2, 4], perWorkerRates = [10, 20, 30], users = 200, durationSeconds = 30, historyBytes = 2048, outputBytes = 2048, profile = 'checkpoint', smoke = false, transport = 'yield' } = {}) {
  if (!workers.length || new Set(workers).size !== workers.length || workers.some((value) => !Number.isInteger(value) || value < 1 || value > 8)) throw new RangeError('Workers must be unique integers within 1..8');
  if (!Number.isInteger(users) || users < Math.max(...workers) || users > 500) throw new RangeError('Users must cover all workers and stay within 500');
  if (!perWorkerRates.length || new Set(perWorkerRates).size !== perWorkerRates.length || perWorkerRates.some((value) => !Number.isFinite(value) || value < 1 || value > 100)) throw new RangeError('Invalid per-worker rates');
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) throw new RangeError('Duration must be within 1..300 seconds');
  if (!Number.isInteger(historyBytes) || historyBytes < 128 || historyBytes > 64 * 1024 || !Number.isInteger(outputBytes) || outputBytes < 128 || outputBytes > 64 * 1024) throw new RangeError('History and output must be within 128..65536 bytes');
  if (profile !== 'checkpoint') throw new RangeError('The public Web host always installs SQLite and checkpoints');
  if (!['direct', 'yield'].includes(transport)) throw new RangeError('Invalid model transport');
  return workers.flatMap((count) =>
    perWorkerRates.map((perWorkerRate) => {
      const rate = count * perWorkerRate;
      if (rate * durationSeconds > 10000) throw new RangeError('A case may offer at most 10000 submissions');
      return { name: `${profile}-w${count}-r${rate}`, workers: count, users, rate, durationSeconds, historyBytes, profile, transport, model: { answerMs: smoke ? 100 : 1000, memoryMs: smoke ? 10 : 100, chunks: smoke ? 4 : 20, outputBytes } };
    }),
  );
}
