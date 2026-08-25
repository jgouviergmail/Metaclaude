import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Dropdown menu built on Radix, so keyboard navigation, focus trapping and
 * dismissal behaviour are correct without reimplementing them.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
export function Menu({ trigger, children, align = 'start', side = 'top', }) {
    return (_jsxs(DropdownMenu.Root, { children: [_jsx(DropdownMenu.Trigger, { asChild: true, children: trigger }), _jsx(DropdownMenu.Portal, { children: _jsx(DropdownMenu.Content, { align: align, side: side, sideOffset: 6, collisionPadding: 12, className: cn('animate-in-up z-50 max-h-[min(24rem,60vh)] min-w-52 overflow-y-auto', 'rounded-xl border border-line bg-raised p-1 shadow-[var(--mc-shadow-lg)]'), children: children }) })] }));
}
export function MenuItem({ children, description, selected, onSelect, tone, icon, disabled, }) {
    return (_jsxs(DropdownMenu.Item, { disabled: disabled, onSelect: onSelect, className: cn('flex cursor-pointer select-none items-start gap-2.5 rounded-lg px-2.5 py-2', 'text-[13px] outline-none transition-colors', 'data-[highlighted]:bg-surface data-[disabled]:pointer-events-none data-[disabled]:opacity-50', tone === 'danger' ? 'text-danger' : 'text-ink'), children: [icon ? _jsx("span", { className: "mt-px shrink-0 [&>svg]:size-4", children: icon }) : null, _jsxs("span", { className: "min-w-0 flex-1", children: [_jsx("span", { className: "block font-medium", children: children }), description ? (_jsx("span", { className: "mt-0.5 block text-[11.5px] leading-snug text-muted", children: description })) : null] }), selected ? _jsx(Check, { className: "mt-px size-3.5 shrink-0 text-accent", "aria-hidden": true }) : null] }));
}
export function MenuSeparator() {
    return _jsx(DropdownMenu.Separator, { className: "my-1 h-px bg-line" });
}
export function MenuLabel({ children }) {
    return (_jsx(DropdownMenu.Label, { className: "px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle", children: children }));
}
//# sourceMappingURL=Menu.js.map