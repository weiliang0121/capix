export const profiles = ['memory', 'sqlite', 'checkpoint', 'recording'];

export function validateCase(value) {
  const integer = (name, min, max) => {
    if (!Number.isSafeInteger(value[name]) || value[name] < min || value[name] > max) throw new Error(`Invalid capacity ${name}`);
  };
  if (!value || !/^[a-z0-9-]+$/.test(value.name) || !profiles.includes(value.profile) || !['burst', 'steady', 'churn'].includes(value.pattern)) throw new Error('Invalid capacity case');
  const transport = value.transport ?? 'yield';
  if (!['direct', 'yield'].includes(transport)) throw new Error('Invalid capacity transport');
  integer('users', 1, 500);
  integer('rounds', 1, 10);
  integer('historyBytes', 128, 64 * 1024);
  integer('durationSeconds', 1, 600);
  if (!Number.isFinite(value.rate) || value.rate < 1 || value.rate > 1000 || value.rate * value.durationSeconds > 20_000) throw new Error('Invalid bounded arrival rate');
  if (!value.model || !Number.isInteger(value.model.answerMs) || value.model.answerMs < 20 || value.model.answerMs > 10_000 || !Number.isInteger(value.model.memoryMs) || value.model.memoryMs < 1 || value.model.memoryMs > 10_000 || !Number.isInteger(value.model.chunks) || value.model.chunks < 1 || value.model.chunks > 100 || !Number.isInteger(value.model.outputBytes) || value.model.outputBytes < 128 || value.model.outputBytes > 64 * 1024) throw new Error('Invalid model workload');
  return { ...value, transport };
}

export function capacityPlan({ smoke = false, users = smoke ? [2, 4] : [10, 50, 100, 200], durationSeconds = smoke ? 1 : 60, rate = smoke ? 8 : 20, transport = 'yield' } = {}) {
  if (!users.length || users.some((value, index) => !Number.isInteger(value) || value < 1 || value > 500 || (index && value <= users[index - 1]))) throw new Error('User steps must be increasing positive integers up to 500');
  const maximum = users.at(-1);
  const base = { rounds: smoke ? 1 : 2, historyBytes: smoke ? 256 : 2048, durationSeconds, rate, transport, model: { answerMs: smoke ? 100 : 1000, chunks: smoke ? 4 : 20, outputBytes: smoke ? 256 : 2048, memoryMs: smoke ? 10 : 100 } };
  return [...users.map((count) => ({ ...base, name: `memory-burst-${count}`, profile: 'memory', pattern: 'burst', users: count })), ...profiles.slice(1).map((profile) => ({ ...base, name: `${profile}-burst-${maximum}`, profile, pattern: 'burst', users: maximum })), ...['memory', 'checkpoint'].map((profile) => ({ ...base, name: `${profile}-steady-${maximum}`, profile, pattern: 'steady', users: maximum })), { ...base, name: `memory-churn-${maximum}`, profile: 'memory', pattern: 'churn', users: maximum, rounds: 1 }].map(validateCase);
}
