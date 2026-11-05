import { verifySharedCancellation } from './verify.mjs';

if (process.argv.length > 2) throw new Error('Usage: node examples/shared-provider/run.mjs (offline only)');
for (const mode of ['direct', 'interaction']) {
  const { references, ...result } = await verifySharedCancellation(mode);
  console.log(JSON.stringify(result, null, 2));
}
console.log('共享实际 ModelProvider 的双会话验证通过；HTTP 使用受控离线 SSE。');
