import { Circle, Diamond } from 'lucide-react';
import { useAppStore } from './state/react';
import { Button } from './components/ui/button';
import { ConversationPanel } from './features/conversation/ConversationPanel';
import { SettingsDialog } from './features/settings/SettingsDialog';
import { ExplorerPanel } from './features/explorer/ExplorerPanel';
import { ObservationDialogs } from './features/inspection/ObservationDialogs';

function Header() {
  const config = useAppStore((state) => state.data.config);
  return (
    <header className="topbar">
      <div className="brand">
        <Diamond size={18} />
        <strong>CAPiX</strong>
        <span>Observer</span>
      </div>
      <div className="connection">
        <Circle size={6} fill="currentColor" />
        {config ? `${config.model} · ${config.configured ? '已连接' : '待配置'}` : '连接中'}
      </div>
    </header>
  );
}

function Notice() {
  const notice = useAppStore((state) => state.notice);
  const setNotice = useAppStore((state) => state.setNotice);
  return (
    <>
      {notice && (
        <div className="app-notice" role="alert">
          <span>{notice}</span>
          <Button variant="ghost" size="sm" onClick={() => setNotice('')}>
            关闭
          </Button>
        </div>
      )}
    </>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <Header />
      <Notice />
      <main className="workspace">
        <ExplorerPanel />
        <ConversationPanel />
      </main>
      <SettingsDialog />
      <ObservationDialogs />
    </div>
  );
}
