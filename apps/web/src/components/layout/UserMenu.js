import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Account menu: identity, theme, transcript display preferences, sign out.
 */
import { Eye, EyeOff, LogOut, Monitor, Moon, Settings, Sun, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { socket } from '@/lib/socket';
import { useAuthStore, useUiStore } from '@/lib/store';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { initials } from '@/lib/utils';
const THEMES = [
    { value: 'light', label: 'Light', icon: _jsx(Sun, {}) },
    { value: 'dark', label: 'Dark', icon: _jsx(Moon, {}) },
    { value: 'system', label: 'System', icon: _jsx(Monitor, {}) },
];
export function UserMenu() {
    const navigate = useNavigate();
    const { user, setUser } = useAuthStore();
    const { theme, setTheme, showThinking, setShowThinking, expandTools, setExpandTools } = useUiStore();
    const signOut = async () => {
        try {
            await api.logout();
        }
        catch {
            // Even if the request fails the local session must be discarded.
        }
        socket.dispose();
        setUser(null);
        navigate('/login', { replace: true });
        toast.success('Signed out');
    };
    if (!user)
        return null;
    return (_jsxs(Menu, { side: "right", align: "end", trigger: _jsx("button", { type: "button", className: "flex size-8 items-center justify-center rounded-lg bg-accent-soft text-[11px] font-semibold text-accent hover:brightness-110", "aria-label": "Account", children: initials(user.displayName || user.username) }), children: [_jsxs(MenuLabel, { children: [user.displayName || user.username, _jsxs("span", { className: "ml-1 font-normal normal-case text-subtle", children: ["(", user.role, ")"] })] }), _jsx(MenuSeparator, {}), _jsx(MenuLabel, { children: "Theme" }), THEMES.map((entry) => (_jsx(MenuItem, { icon: entry.icon, selected: theme === entry.value, onSelect: () => setTheme(entry.value), children: entry.label }, entry.value))), _jsx(MenuSeparator, {}), _jsx(MenuLabel, { children: "Transcript" }), _jsx(MenuItem, { icon: showThinking ? _jsx(Eye, {}) : _jsx(EyeOff, {}), selected: showThinking, 
                // The menu stays open so several preferences can be toggled at once.
                onSelect: () => setShowThinking(!showThinking), children: "Show reasoning" }), _jsx(MenuItem, { icon: _jsx(Wrench, {}), selected: expandTools, onSelect: () => setExpandTools(!expandTools), children: "Expand tool calls" }), _jsx(MenuSeparator, {}), _jsx(MenuItem, { icon: _jsx(Settings, {}), onSelect: () => navigate('/settings'), children: "Settings" }), _jsx(MenuItem, { icon: _jsx(LogOut, {}), tone: "danger", onSelect: () => void signOut(), children: "Sign out" })] }));
}
//# sourceMappingURL=UserMenu.js.map