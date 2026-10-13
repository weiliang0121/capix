import { useEffect, useState } from 'react';
import type { ConversationDescriptor } from '@capix/protocol';
import { useAppCommands, useAppStore } from '../../state/react.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { errorMessage } from '../../lib/errors.js';

interface ConversationHistoryListProps {
  conversations: readonly ConversationDescriptor[];
  currentId?: string;
  canSwitch: boolean;
  switching: boolean;
  onOpen: (id: string) => void;
}

export function ConversationHistoryList({ conversations, currentId, canSwitch, switching, onOpen }: ConversationHistoryListProps) {
  return (
    <ul className="conversation-history-list" aria-label="历史对话列表">
      {conversations.map((conversation) => {
        const current = conversation.id === currentId;
        return (
          <li key={conversation.id}>
            <button type="button" aria-current={current ? 'true' : undefined} disabled={switching || (!current && !canSwitch)} onClick={() => onOpen(conversation.id)}>
              <div className="conversation-history-title">
                <strong>{conversation.title}</strong>
                {current && <Badge variant="secondary">当前</Badge>}
              </div>
              <time dateTime={new Date(conversation.updatedAt).toISOString()}>{new Date(conversation.updatedAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ConversationHistory({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const conversations = useAppStore((state) => state.data.conversations);
  const current = useAppStore((state) => state.data.activeConversation);
  const canSwitch = useAppStore((state) => state.data.canSwitchConversation);
  const switching = useAppStore((state) => state.data.switchingConversation);
  const { refreshConversations, openConversation } = useAppCommands();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    void refreshConversations()
      .catch((failure) => {
        if (active) setError(errorMessage(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, refresh, refreshConversations]);
  const select = async (id: string) => {
    if (current?.id === id) {
      onOpenChange(false);
      return;
    }
    setError('');
    try {
      await openConversation(id);
      onOpenChange(false);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="conversation-history-dialog">
        <DialogHeader>
          <DialogTitle>历史对话</DialogTitle>
          <DialogDescription>{switching ? '正在打开对话…' : canSwitch ? '打开一段对话，查看或继续交流。' : '当前消息处理结束且待发送队列为空后，可以切换对话。'}</DialogDescription>
        </DialogHeader>
        {loading && <p role="status">正在加载历史对话…</p>}
        {error && (
          <div className="conversation-history-error" role="alert">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)} disabled={loading || switching}>
              重新加载列表
            </Button>
          </div>
        )}
        {!loading && !error && !conversations.length && <p>暂无历史对话。</p>}
        <ConversationHistoryList conversations={conversations} currentId={current?.id} canSwitch={canSwitch} switching={switching} onOpen={(id) => void select(id)} />
      </DialogContent>
    </Dialog>
  );
}
