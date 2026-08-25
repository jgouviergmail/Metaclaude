import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Workspace file explorer and editor.
 *
 * Two modes in one panel: a directory listing (or a filename search, when the
 * box has something in it) and a CodeMirror editor for a single file. Keeping
 * them in one component means the breadcrumb, the refresh and the close button
 * behave identically either way.
 *
 * Language support is code-split. The editor is already a large chunk; pulling
 * in nine grammars for a file that needs one would double it, so each grammar
 * is imported on demand once a file's language is known.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { oneDark } from '@codemirror/theme-one-dark';
import CodeMirror from '@uiw/react-codemirror';
import { ArrowLeft, ChevronRight, File as FileIcon, FileWarning, Folder, Home, RefreshCw, Save, Search, TriangleAlert, X, } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, EmptyState, Input, Spinner, Tooltip } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { cn, formatBytes, isModifier, shortcut, truncate } from '@/lib/utils';
export function FilesPanel({ workspaceId, onClose }) {
    const queryClient = useQueryClient();
    const [path, setPath] = useState('');
    const [openPath, setOpenPath] = useState(null);
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    // Typing a path fragment fires a recursive walk on the server; wait for a
    // pause before spending that.
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
        return () => clearTimeout(timer);
    }, [query]);
    const searching = debouncedQuery.length >= 2;
    const listing = useQuery({
        queryKey: ['files', workspaceId, path],
        queryFn: () => api.files(workspaceId, path),
    });
    const search = useQuery({
        queryKey: ['file-search', workspaceId, debouncedQuery],
        queryFn: () => api.searchFiles(workspaceId, debouncedQuery),
        enabled: searching,
    });
    const refresh = () => {
        if (openPath)
            void queryClient.invalidateQueries({ queryKey: ['file', workspaceId, openPath] });
        else if (searching)
            void search.refetch();
        else
            void queryClient.invalidateQueries({ queryKey: ['files', workspaceId, path] });
    };
    const openEntry = (entry) => {
        if (entry.type === 'directory') {
            setPath(entry.path);
            setQuery('');
            setDebouncedQuery('');
            return;
        }
        setOpenPath(entry.path);
    };
    const entries = searching ? (search.data?.entries ?? []) : (listing.data?.entries ?? []);
    const loading = searching ? search.isPending : listing.isPending;
    return (_jsxs("div", { className: "flex h-full min-h-0 flex-col", children: [_jsxs("header", { className: "flex h-12 shrink-0 items-center gap-2 border-b border-line px-3", children: [_jsx("h2", { className: "min-w-0 flex-1 truncate text-sm font-semibold text-ink", children: "Files" }), _jsx(Tooltip, { content: "Refresh", children: _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Refresh files", onClick: refresh, children: _jsx(RefreshCw, { className: "size-4" }) }) }), _jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Close files", onClick: onClose, children: _jsx(X, { className: "size-4" }) })] }), openPath ? (_jsx(FileEditor, { workspaceId: workspaceId, path: openPath, onBack: () => setOpenPath(null) })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "shrink-0 space-y-2 border-b border-line px-3 py-2", children: [_jsx(Breadcrumb, { path: path, onNavigate: setPath }), _jsxs("div", { className: "relative", children: [_jsx(Search, { className: "pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle", "aria-hidden": true }), _jsx(Input, { type: "search", value: query, onChange: (event) => setQuery(event.target.value), placeholder: "Find a file by name", "aria-label": "Find a file by name", className: "h-8 pl-8 text-[13px]" })] })] }), _jsx("div", { className: "min-h-0 flex-1 overflow-y-auto p-1.5", children: loading ? (_jsx("div", { className: "flex justify-center py-10", children: _jsx(Spinner, {}) })) : listing.isError && !searching ? (_jsx(EmptyState, { icon: _jsx(FileWarning, {}), title: "This folder could not be read", description: listing.error instanceof ApiError
                                ? listing.error.message
                                : 'The directory may have been moved or deleted.', action: _jsx(Button, { variant: "secondary", size: "sm", onClick: () => setPath(''), children: "Back to the root" }) })) : entries.length === 0 ? (_jsx(EmptyState, { icon: _jsx(Folder, {}), title: searching ? 'Nothing matched' : 'This folder is empty', description: searching ? `No file name contains “${debouncedQuery}”.` : undefined })) : (_jsx("ul", { children: entries.map((entry) => (_jsx("li", { children: _jsxs("button", { type: "button", onClick: () => openEntry(entry), className: "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-raised", children: [entry.type === 'directory' ? (_jsx(Folder, { className: "size-4 shrink-0 text-accent", "aria-hidden": true })) : (_jsx(FileIcon, { className: "size-4 shrink-0 text-subtle", "aria-hidden": true })), _jsx("span", { className: "min-w-0 flex-1 truncate text-[13px] text-ink", children: entry.name }), _jsx("span", { className: "shrink-0 text-[11px] tabular-nums text-subtle", children: searching
                                                ? truncate(entry.path, 34)
                                                : entry.type === 'file'
                                                    ? formatBytes(entry.size)
                                                    : '' })] }) }, entry.path))) })) })] }))] }));
}
/* -------------------------------------------------------------------------- */
/* Breadcrumb                                                                  */
/* -------------------------------------------------------------------------- */
function Breadcrumb({ path, onNavigate }) {
    const segments = path ? path.split('/').filter(Boolean) : [];
    return (_jsxs("nav", { className: "flex flex-wrap items-center gap-0.5 text-[12px]", "aria-label": "Folder path", children: [_jsx("button", { type: "button", onClick: () => onNavigate(''), "aria-label": "Workspace root", className: "flex items-center rounded px-1 py-0.5 text-subtle transition-colors hover:bg-raised hover:text-ink", children: _jsx(Home, { className: "size-3.5", "aria-hidden": true }) }), segments.map((segment, index) => {
                const target = segments.slice(0, index + 1).join('/');
                const last = index === segments.length - 1;
                return (_jsxs("span", { className: "flex items-center gap-0.5", children: [_jsx(ChevronRight, { className: "size-3 shrink-0 text-subtle", "aria-hidden": true }), _jsx("button", { type: "button", onClick: () => onNavigate(target), disabled: last, className: cn('rounded px-1 py-0.5 transition-colors', last
                                ? 'font-medium text-ink'
                                : 'text-muted hover:bg-raised hover:text-ink'), children: segment })] }, target));
            })] }));
}
/* -------------------------------------------------------------------------- */
/* Editor                                                                      */
/* -------------------------------------------------------------------------- */
function FileEditor({ workspaceId, path, onBack, }) {
    const queryClient = useQueryClient();
    const dark = useDarkTheme();
    const [draft, setDraft] = useState('');
    const [baseline, setBaseline] = useState('');
    const [language, setLanguage] = useState(null);
    const file = useQuery({
        queryKey: ['file', workspaceId, path],
        queryFn: () => api.readFile(workspaceId, path),
        // A binary or missing file will fail the same way every time; retrying only
        // delays the message.
        retry: false,
        staleTime: Infinity,
    });
    // Re-seed the buffer whenever the file is (re)fetched. `dataUpdatedAt` is in
    // the deps so an explicit refresh discards the draft along with the old text.
    useEffect(() => {
        if (!file.data)
            return;
        setDraft(file.data.content);
        setBaseline(file.data.content);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file.data?.path, file.dataUpdatedAt]);
    useEffect(() => {
        let cancelled = false;
        setLanguage(null);
        const name = file.data?.language;
        if (!name)
            return;
        void languageExtension(name).then((extension) => {
            if (!cancelled)
                setLanguage(extension);
        });
        return () => {
            cancelled = true;
        };
    }, [file.data?.language]);
    const save = useMutation({
        mutationFn: (content) => api.writeFile(workspaceId, path, content),
        onSuccess: (_data, content) => {
            setBaseline(content);
            toast.success(`Saved ${path.split('/').pop() ?? path}`);
            // The listing carries size and mtime, both of which just changed.
            void queryClient.invalidateQueries({ queryKey: ['files', workspaceId] });
        },
        onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save the file.'),
    });
    const truncated = file.data?.truncated ?? false;
    const dirty = draft !== baseline;
    const canSave = dirty && !truncated && !save.isPending;
    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key.toLowerCase() !== 's' || !isModifier(event))
                return;
            // Always swallow it: the browser's "save page" dialog over an editor is
            // never what the shortcut was aimed at.
            event.preventDefault();
            if (canSave)
                save.mutate(draft);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [canSave, draft, save.mutate]);
    const extensions = useMemo(() => (language ? [language] : []), [language]);
    return (_jsxs("div", { className: "flex min-h-0 flex-1 flex-col", children: [_jsxs("div", { className: "flex shrink-0 items-center gap-2 border-b border-line px-2 py-2", children: [_jsx(Button, { variant: "ghost", size: "icon-sm", "aria-label": "Back to files", onClick: onBack, children: _jsx(ArrowLeft, { className: "size-4" }) }), _jsx("code", { className: "min-w-0 flex-1 truncate font-mono text-[12px] text-muted", title: path, children: path }), dirty ? (_jsx("span", { className: "size-1.5 shrink-0 rounded-full bg-warning", role: "img", "aria-label": "Unsaved changes", title: "Unsaved changes" })) : null, _jsx(Tooltip, { content: `Save (${shortcut('S')})`, children: _jsxs(Button, { variant: "primary", size: "sm", onClick: () => save.mutate(draft), disabled: !canSave, loading: save.isPending, children: [_jsx(Save, { className: "size-3.5", "aria-hidden": true }), "Save"] }) })] }), file.isPending ? (_jsx("div", { className: "flex flex-1 items-center justify-center", children: _jsx(Spinner, {}) })) : file.isError ? (_jsx(EmptyState, { icon: _jsx(FileWarning, {}), title: readErrorTitle(file.error), description: file.error instanceof ApiError
                    ? file.error.message
                    : 'The file could not be read.', action: _jsxs(Button, { variant: "secondary", size: "sm", onClick: onBack, children: [_jsx(ArrowLeft, { className: "size-4" }), "Back to files"] }) })) : (_jsxs(_Fragment, { children: [truncated ? (_jsxs("p", { className: "flex shrink-0 items-start gap-2 border-b border-line bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-warning", children: [_jsx(TriangleAlert, { className: "mt-px size-3.5 shrink-0", "aria-hidden": true }), _jsxs("span", { children: ["This file is ", formatBytes(file.data.size), " \u2014 only the beginning is shown. Editing is disabled, because saving what is on screen would truncate the file on disk."] })] })) : null, _jsx("div", { className: "min-h-0 flex-1 overflow-auto text-[13px]", children: _jsx(CodeMirror, { value: draft, onChange: setDraft, extensions: extensions, 
                            // `oneDark` is the only dark editor theme in the bundle; in light
                            // mode CodeMirror's own default already matches the surface.
                            theme: dark ? oneDark : 'light', editable: !truncated, height: "100%", basicSetup: { foldGutter: false, highlightActiveLine: !truncated }, "aria-label": `Contents of ${path}` }) })] }))] }));
}
function readErrorTitle(error) {
    if (error instanceof ApiError && error.status === 415)
        return 'This file is not text';
    if (error instanceof ApiError && error.status === 404)
        return 'This file no longer exists';
    return 'This file could not be opened';
}
/** The theme switch only toggles a class, so watch for it rather than polling. */
function useDarkTheme() {
    const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
    useEffect(() => {
        const observer = new MutationObserver(() => {
            setDark(document.documentElement.classList.contains('dark'));
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);
    return dark;
}
/**
 * Resolve a language name from the server to a CodeMirror extension.
 * Anything not listed renders as plain text, which is a perfectly usable
 * editor — a missing grammar is not an error worth surfacing.
 */
async function languageExtension(language) {
    switch (language) {
        case 'typescript':
        case 'tsx':
        case 'javascript':
        case 'jsx': {
            const { javascript } = await import('@codemirror/lang-javascript');
            return javascript({ jsx: true, typescript: true });
        }
        case 'json': {
            const { json } = await import('@codemirror/lang-json');
            return json();
        }
        case 'markdown': {
            const { markdown } = await import('@codemirror/lang-markdown');
            return markdown();
        }
        case 'python': {
            const { python } = await import('@codemirror/lang-python');
            return python();
        }
        case 'rust': {
            const { rust } = await import('@codemirror/lang-rust');
            return rust();
        }
        case 'css':
        case 'scss':
        case 'less': {
            const { css } = await import('@codemirror/lang-css');
            return css();
        }
        case 'html':
        case 'vue':
        case 'svelte': {
            const { html } = await import('@codemirror/lang-html');
            return html();
        }
        case 'sql': {
            const { sql } = await import('@codemirror/lang-sql');
            return sql();
        }
        default:
            return null;
    }
}
//# sourceMappingURL=FilesPanel.js.map