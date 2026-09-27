import { useAppStore } from '../../state/react';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import './settings.css';
export function SettingsDialog() {
  const config = useAppStore((state) => state.data.config);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const budget = useAppStore((state) => state.budget);
  const setBudget = useAppStore((state) => state.setBudget);
  const history = useAppStore((state) => state.history);
  const setHistory = useAppStore((state) => state.setHistory);
  const fillExample = useAppStore((state) => state.fillExample);
  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="settings-dialog">
        <DialogHeader>
          <DialogTitle>对话设置</DialogTitle>
          <DialogDescription>执行开始时捕获配置；修改只对下一轮生效。</DialogDescription>
        </DialogHeader>
        <div className="settings-field">
          <label htmlFor="budget">请求容量预算</label>
          <Input id="budget" type="number" min={256} max={1000000} value={budget} onChange={(event) => setBudget(event.target.value)} />
          <p>完整模型请求按 UTF-8 字节估算，包含输出预留。不是模型的上下文窗口大小。</p>
        </div>
        <div className="settings-field">
          <span>模型</span>
          <strong>{config?.model ?? '读取中'}</strong>
          <p>模型与连接信息由服务端提供。</p>
        </div>
        <details className="history-editor">
          <summary>下一轮追加已有消息</summary>
          <p>仅用于接纳原始 user / assistant 消息；不会创建历史执行记录。</p>
          <Textarea aria-label="追加历史 JSON" value={history} onChange={(event) => setHistory(event.target.value)} spellCheck={false} />
          <Button variant="secondary" size="sm" onClick={fillExample}>
            填入澄清样例
          </Button>
        </details>
        <Button onClick={() => setSettingsOpen(false)}>完成</Button>
      </DialogContent>
    </Dialog>
  );
}
