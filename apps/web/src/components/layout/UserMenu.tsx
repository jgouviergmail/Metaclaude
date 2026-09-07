/**
 * Account menu: identity, theme, transcript display preferences, sign out.
 */

import { Eye, EyeOff, LogOut, Monitor, Moon, Settings, Sun, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { useAuthStore, useUiStore, type ThemeMode } from '@/lib/store';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { initials } from '@/lib/utils';
import { routes } from '@metaclaude/shared';

const THEMES: Array<{ value: ThemeMode; label: string; icon: React.ReactNode }> = [
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
  { value: 'system', label: 'System', icon: <Monitor /> },
];

export function UserMenu() {
  const t = useT();
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
    navigate(routes.login(), { replace: true });
    toast.success(t('Signed out'));
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
          aria-label={t('Account')}
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

      <MenuLabel>{t('Theme')}</MenuLabel>
      {THEMES.map((entry) => (
        <MenuItem
          key={entry.value}
          icon={entry.icon}
          selected={theme === entry.value}
          onSelect={() => setTheme(entry.value)}
        >
          {t(entry.label)}
        </MenuItem>
      ))}

      <MenuSeparator />
      <MenuLabel>{t('Transcript')}</MenuLabel>
      {/* `keepOpen` on both, so the two transcript preferences can be set in
          one opening. The comment here used to claim exactly that while the
          prop was missing, which closed the menu after the first toggle. */}
      <MenuItem
        icon={showThinking ? <Eye /> : <EyeOff />}
        selected={showThinking}
        keepOpen
        onSelect={() => setShowThinking(!showThinking)}
      >
        {t('Show reasoning')}
      </MenuItem>
      <MenuItem
        icon={<Wrench />}
        selected={expandTools}
        keepOpen
        onSelect={() => setExpandTools(!expandTools)}
      >
        {t('Expand tool calls')}
      </MenuItem>

      <MenuSeparator />
      <MenuItem icon={<Settings />} onSelect={() => navigate(routes.settings())}>
        {t('Settings')}
      </MenuItem>
      <MenuItem icon={<LogOut />} tone="danger" onSelect={() => void signOut()}>
        {t('Sign out')}
      </MenuItem>
    </Menu>
  );
}
