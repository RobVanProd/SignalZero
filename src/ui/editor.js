// GNU nano look-alike for editing config files on Linux hosts. Ctrl+O saves, Ctrl+X exits.
import { h, overlay } from './dom.js';

export function openEditor(app, { dev, path, text, isNew }, onDone) {
  let dirty = false;
  const ta = h('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': `editing ${path}` });
  ta.value = text;
  const gutter = h('div', { class: 'ed-gutter' });
  const status = h('span', {}, isNew ? '[ New File ]' : '');
  const msg = h('div', { class: 'ed-msg' }, isNew ? `[ New File ]` : `[ Read ${text.split('\n').length} lines ]`);
  const top = h('div', { class: 'ed-top' }, h('span', {}, 'GNU nano 7.2'), h('span', {}, path), status);
  const lines = () => { gutter.textContent = ta.value.split('\n').map((_, i) => String(i + 1)).join('\n'); };
  lines();
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('input', () => { dirty = true; status.textContent = 'Modified'; lines(); });
  const save = () => {
    app.saveFile(dev, path, ta.value);
    dirty = false;
    status.textContent = '';
    msg.textContent = `[ Wrote ${ta.value.split('\n').length} lines ]`;
  };
  const exit = () => {
    if (dirty && !confirm('Save modified buffer?  (Cancel = discard changes)')) { close(); return; }
    if (dirty) save();
    close();
  };
  const close = () => { ov.remove(); app.editorOpen = false; onDone?.(); app.focusTerminal(); };
  ta.addEventListener('keydown', e => {
    if (e.ctrlKey && (e.key === 'o' || e.key === 's')) { e.preventDefault(); save(); }
    else if (e.ctrlKey && e.key === 'x') { e.preventDefault(); exit(); }
    else if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
    else if (e.key === 'Escape') e.preventDefault();
    e.stopPropagation();
  });
  const keys = h('div', { class: 'ed-keys' },
    h('button', { onclick: save }, h('b', {}, '^O'), 'Write Out'),
    h('button', { onclick: exit }, h('b', {}, '^X'), 'Exit'),
    h('span', {}, h('b', {}, '^S'), 'Save'),
    h('span', { style: { marginLeft: 'auto', color: '#7d8a94' } }, 'Edits take effect only when the service reloads or restarts.'));
  const ed = h('div', { class: 'editor', role: 'dialog', 'aria-label': 'text editor' }, top, h('div', { class: 'ed-body' }, gutter, ta), msg, keys);
  const ov = overlay(ed, { dismissable: false, cls: 'editor-ov' });
  ov.style.zIndex = 25;
  app.editorOpen = true;
  setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 30);
}
