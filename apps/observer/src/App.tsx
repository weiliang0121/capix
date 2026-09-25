import { Circle, Diamond } from 'lucide-react';
import { useAppStore, useClientState } from './state/react';
import { Button } from './components/ui/button';
import { ConversationPanel, SettingsDialog } from './components/conversation';
import { ExplorerPanel, ObservationDialogs } from './components/runtime-panels';

function Header() {
  const config = useClientState((state) => state.config);
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
