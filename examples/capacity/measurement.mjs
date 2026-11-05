import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (percent) => (sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)] : null);
  return { count: sorted.length, min: sorted[0] ?? null, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}

/** Process metrics, not machine-wide CPU. 100% represents one occupied CPU core. */
export function measureProcess() {
  let started = performance.now();
  let cpu = process.cpuUsage();
  let utilization = performance.eventLoopUtilization();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let initial = process.memoryUsage();
  const peak = { ...initial };
  const sample = () => {
    const memory = process.memoryUsage();
    for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], memory[key]);
  };
  delay.enable();
  const timer = setInterval(sample, 50);
  return {
    reset() {
      started = performance.now();
      cpu = process.cpuUsage();
      utilization = performance.eventLoopUtilization();
      initial = process.memoryUsage();
      Object.assign(peak, initial);
      delay.reset();
    },
    stop() {
      clearInterval(timer);
      sample();
      delay.disable();
      const elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      return {
        elapsedMs,
        cpuMs: (used.user + used.system) / 1000,
        cpuPercentOfOneCore: (used.user + used.system) / (elapsedMs * 10),
        eventLoopUtilization: performance.eventLoopUtilization(utilization).utilization,
        eventLoopDelayMs: { p50: delay.count ? delay.percentile(50) / 1e6 : null, p95: delay.count ? delay.percentile(95) / 1e6 : null, p99: delay.count ? delay.percentile(99) / 1e6 : null, max: delay.count ? delay.max / 1e6 : null },
        memory: { initial, peakSampled: peak, final: process.memoryUsage(), processMaxRssBytes: process.resourceUsage().maxRSS * 1024 },
      };
    },
  };
}

export function modelMeter(provider) {
  const calls = [];
  let active = 0;
  let peakActive = 0;
  return {
    calls,
    get active() {
      return active;
    },
    get peakActive() {
      return peakActive;
    },
    model: {
      async complete(request, controls = {}) {
        const started = performance.now();
        const call = { phase: request.stream ? 'answer' : 'memory', requestBytes: Buffer.byteLength(JSON.stringify(request)), firstDeltaMs: null, deltaBytes: 0, deltaCount: 0 };
        calls.push(call);
        active++;
        peakActive = Math.max(peakActive, active);
        try {
          const reply = await provider.complete(request, {
            ...controls,
            ...(request.stream
              ? {
                  emit(text) {
                    call.firstDeltaMs ??= performance.now() - started;
                    call.deltaBytes += Buffer.byteLength(text);
                    call.deltaCount++;
                    controls.emit?.(text);
                  },
                }
              : {}),
          });
          call.status = 'succeeded';
          return reply;
        } catch (error) {
          call.status = 'failed';
          call.code = typeof error?.code === 'string' ? error.code : 'ERROR';
          throw error;
        } finally {
          active--;
          call.elapsedMs = performance.now() - started;
        }
      },
    },
  };
}
