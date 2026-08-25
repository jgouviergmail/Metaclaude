/**
 * Account menu: identity, theme, transcript display preferences, sign out.
 */

import { Eye, EyeOff, LogOut, Monitor, Moon, Settings, Sun, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { useAuthStore, useUiStore, type ThemeMode } from '@/lib/store';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { initials } from '@/lib/utils';

const THEMES: Array<{ value: ThemeMode; label: string; icon: React.ReactNode }> = [
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
  { value: 'system', label: 'System', icon: <Monitor /> },
];

export function UserMenu() {
  const navigate = useNavigate();
  const { user, setUser } = useAuthStore();
  const { theme, setTheme, showThinking, setShowThinking, expandTools, setExpandTools } =
    useUiStore();

  const signOut = async (): Promise<void> => {
    try {
      await api.logout();
    } catch {
      // Even if the request fails the local session must be discarded.
    }
    socket.dispose();
    setUser(null);
    navigate('/login', { replace: true });
    toast.success('Signed out');
  };

  if (!user) return null;

  return (
    <Menu
      side="right"
      align="end"
      trigger={
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-[11px] font-semibold text-accent hover:brightness-110"
          aria-label="Account"
        >
          {initials(user.displayName || user.username)}
        </button>
      }
    >
      <MenuLabel>
        {user.displayName || user.username}
        <span className="ml-1 font-normal normal-case text-subtle">({user.role})</span>
      </MenuLabel>
      <MenuSeparator />

      <MenuLabel>Theme</MenuLabel>
      {THEMES.map((entry) => (
        <MenuItem
          key={entry.value}
          icon={entry.icon}
          selected={theme === entry.value}
          onSelect={() => setTheme(entry.value)}
        >
          {entry.label}
        </MenuItem>
      ))}

      <MenuSeparator />
      <MenuLabel>Transcript</MenuLabel>
      <MenuItem
        icon={showThinking ? <Eye /> : <EyeOff />}
        selected={showThinking}
        // The menu stays open so several preferences can be toggled at once.
        onSelect={() => setShowThinking(!showThinking)}
      >
        Show reasoning
      </MenuItem>
      <MenuItem
        icon={<Wrench />}
        selected={expandTools}
        onSelect={() => setExpandTools(!expandTools)}
      >
        Expand tool calls
      </MenuItem>

      <MenuSeparator />
      <MenuItem icon={<Settings />} onSelect={() => navigate('/settings')}>
        Settings
      </MenuItem>
      <MenuItem icon={<LogOut />} tone="danger" onSelect={() => void signOut()}>
        Sign out
      </MenuItem>
    </Menu>
  );
}
