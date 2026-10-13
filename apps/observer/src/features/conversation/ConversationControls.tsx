import { History, Plus, Settings2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';

interface ConversationControlsProps {
  canSwitch: boolean;
  switching: boolean;
  onCreate: () => void;
  onHistory: () => void;
  onSettings: () => void;
}

export function ConversationControls({ canSwitch, switching, onCreate, onHistory, onSettings }: ConversationControlsProps) {
  return (
    <div className="conversation-controls" role="group" aria-label="对话管理">
      <Button variant="ghost" size="sm" disabled={!canSwitch || switching} onClick={onCreate} aria-label="新建对话">
        <Plus aria-hidden="true" />
        <span>新建</span>
      </Button>
      <Button variant="ghost" size="sm" onClick={onHistory} aria-label="历史对话">
        <History aria-hidden="true" />
        <span>历史</span>
      </Button>
      <Button variant="ghost" size="sm" onClick={onSettings} aria-label="对话设置">
        <Settings2 aria-hidden="true" />
        <span>配置</span>
      </Button>
    </div>
  );
}
