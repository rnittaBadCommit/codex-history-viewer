const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'media/chatView.js'), 'utf8');
const ast = ts.createSourceFile('chatView.js', source, ts.ScriptTarget.Latest, true);
const functions = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
})(ast);

// Layout-aware DOM fixture. Execute the production functions, including target
// resolution and scroll restoration; no browser/VS Code behavior is simulated
// beyond these explicit DOM and host boundaries.
class Element {
  constructor(tag = 'div', classes = '') {
    this.tagName = tag.toUpperCase(); this.parentElement = null; this.children = [];
    this.dataset = {}; this.classes = new Set(classes.split(' ').filter(Boolean));
    this.classList = { contains: x => this.classes.has(x), add: x => this.classes.add(x),
      remove: x => this.classes.delete(x), toggle: (x, on) => on ? this.classes.add(x) : this.classes.delete(x) };
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      const tag = part.match(/^[a-z][a-z0-9]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if ([...part.matchAll(/\.([\w-]+)/g)].some(m => !this.classes.has(m[1]))) return false;
      for (const [, attr, value] of part.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\]/g)) {
        const actual = attr.startsWith('data-') ? this.dataset[attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this[attr];
        if (actual === undefined || (value !== undefined && String(actual) !== value)) return false;
      }
      return true;
    });
  }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
  contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.document.activeElement = this; }
}
class HTMLInputElement extends Element {}
class HTMLTextAreaElement extends Element {}
function fixture(mode = 'off', count = 2) {
  const timelineEl = new Element('div');
  const scrollRoot = new Element('div'); scrollRoot.append(timelineEl);
  scrollRoot.clientHeight = 700; scrollRoot.scrollTop = 0;
  scrollRoot.getBoundingClientRect = () => ({ top: 40, bottom: 740 });
  const document = { activeElement: null, hasFocus: () => true, getElementById: id => timelineEl.querySelectorAll('.bubble').find(b => b.id === id) || null };
  const sent = []; let persisted = 0; let renders = 0;
  const context = vm.createContext({ Element, HTMLElement: Element, HTMLInputElement, HTMLTextAreaElement, document, timelineEl,
    vscode: { postMessage: msg => sent.push(msg) }, getScrollRoot: () => scrollRoot,
    withPageSearchContentMutation: mutate => mutate(), suppressStickyUserUntilUserScroll: () => {},
    restoreHighlight: () => {}, persistCurrentChatOpenPosition: () => persisted++, persistRestorePosition: () => persisted++,
    cancelRenderAfterCurrent: () => {}, resetPageSearchState: () => {}, closeImagePreview: () => {}, isImagePreviewOpen: () => false,
    resetImageDataCache: () => {}, resetPatchEntryDetailsCache: () => {}, resetStickyUserSuppression: () => {}, clearAllPageSearchTemporaryExpansions: () => {},
    imagePreview: null,
  });
  const names = ['resolveMessageCollapseState', 'canCollapseMessage', 'countMessageLines', 'toggleMessageExpansion',
    'resolveAnswerBody', 'configureAnswerBody', 'isAnswerInteractiveTarget', 'handleAnswerSelection', 'handleAnswerMiddleDown',
    'handleAnswerAuxClick', 'handleAnswerDoubleClick', 'canUseAnswerShortcut', 'syncAnswerShortcutFocus', 'isTextInputElement',
    'handleAnswerExpansionCommand', 'resetSessionScopedUiState'];
  vm.runInContext(`let expandedMessageIndexes = new Set(), manuallyCollapsedMessageIndexes = new Set();
    let selectedAnswerMessageIndex = null, selectedMessageIndex = null, answerContextRevision = 1;
    let answerShortcutComposing = false, answerShortcutRepeat = false, showDetails = false;
    let model = {fsPath: '/session-a'}, userLongMessageFolding = '${mode}', assistantLongMessageFolding = '${mode}';
    ${names.map(n => functions.get(n)).join('\n')}`, context);
  const run = code => vm.runInContext(code, context);
  const items = [{role:'user', messageIndex:0, text:'Question'}];
  for (let n = 1; n <= count; n++) items.push({role:'assistant', messageIndex:n, text:'# Heading\n' + 'Long answer paragraph.\n'.repeat(1000)});
  items.push({role:'tool', messageIndex:count+1, text:'Tool output'});
  context.renderOrRequestAfterCurrent = cb => { render(); cb(); };
  function render() {
    renders++; timelineEl.children = []; let start = 0;
    for (const item of items) {
      const state = context.resolveMessageCollapseState(item, item.role, item.text);
      const bubble = new Element('div', `bubble ${item.role}`); bubble.id = `msg-${item.messageIndex}`;
      bubble.document = document;
      const body = new Element('div', `messageBody messageBody-${item.role}${state.collapsed ? ' messageBody-collapsed' : ''}`);
      context.configureAnswerBody(bubble, body, item, item.text, state);
      const top = start; const height = item.role === 'assistant' ? (state.collapsed ? 320 : 20000) : 500;
      bubble.getBoundingClientRect = () => ({ top:40+top-scrollRoot.scrollTop, bottom:40+top+height-scrollRoot.scrollTop });
      bubble.append(body); timelineEl.append(bubble);
      for (const tag of ['h2', 'td', 'code', 'p', 'a', 'button', 'svg']) body.append(new Element(tag));
      start += height + 80;
    }
    scrollRoot.scrollTop = Math.max(0, Math.min(scrollRoot.scrollTop, start - scrollRoot.clientHeight));
  }
  render();
  const bubble = n => document.getElementById(`msg-${n}`);
  const body = n => bubble(n).children[0];
  const event = (target, button = 1) => ({target, button, defaultPrevented:false, propagationStopped:false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }});
  return {context, run, bubble, body, event, scrollRoot, sent, render, items, document,
    collapsed:n=>body(n).classList.contains('messageBody-collapsed'), get renders(){return renders;}, get persisted(){return persisted;}};
}

for (const [location, tag] of [['start','h2'], ['middle','td'], ['end','code']]) {
  test(`middle-click at answer ${location} targets only that answer and cancels autoscroll`, () => {
    const f = fixture(); const target = f.body(2).querySelector(tag); const e = f.event(target);
    f.context.handleAnswerMiddleDown(e);
    assert.equal(f.collapsed(2), true); assert.equal(f.collapsed(1), false);
    assert.equal(e.defaultPrevented, true); assert.equal(e.propagationStopped, true);
    assert.equal(f.persisted, 2);
    const aux = f.event(f.body(2)); f.context.handleAnswerAuxClick(aux);
    assert.equal(aux.defaultPrevented, true); assert.equal(f.collapsed(2), true);
    f.context.handleAnswerMiddleDown(f.event(f.body(2).querySelector('p')));
    assert.equal(f.collapsed(2), false);
  });
}
test('nested SVG and text-node targets resolve through the assistant body', () => {
  const f = fixture(); const svg = f.body(1).querySelector('svg');
  assert.equal(f.context.resolveAnswerBody(svg).messageIndex, 1);
  assert.equal(f.context.resolveAnswerBody({parentElement:svg}).messageIndex, 1);
});
test('tool, unrelated UI, links and buttons retain their middle-click behavior', () => {
  const f = fixture();
  for (const target of [f.body(3), new Element(), f.body(1).querySelector('a'), f.body(1).querySelector('button')]) {
    const e = f.event(target); f.context.handleAnswerMiddleDown(e); f.context.handleAnswerAuxClick(e);
    assert.equal(e.defaultPrevented, false);
  }
  assert.equal(f.renders, 1);
});
test('left-click selects with a border and native command toggles both ways', () => {
  const f = fixture(); const e = f.event(f.body(2).querySelector('code'), 0);
  f.context.handleAnswerSelection(e);
  assert.equal(e.defaultPrevented, false); assert.equal(f.bubble(2).classList.contains('answerSelected'), true);
  f.context.handleAnswerExpansionCommand({action:'toggle'}); assert.equal(f.collapsed(2), true);
  f.context.handleAnswerExpansionCommand({action:'toggle'}); assert.equal(f.collapsed(2), false);
  f.context.handleAnswerSelection(f.event(f.body(0), 0));
  f.context.handleAnswerExpansionCommand({action:'toggle'}); assert.equal(f.collapsed(2), false);
});
test('input, contenteditable, inert overlays, IME, repeat and lost focus block keyboard folding', () => {
  const f = fixture(); f.context.handleAnswerSelection(f.event(f.body(1),0));
  const input = new HTMLInputElement('input'); const area = new HTMLTextAreaElement('textarea');
  const editable = new Element(); editable.isContentEditable = true;
  for (const active of [input, area, editable, f.body(1).querySelector('button')]) {
    f.document.activeElement = active; f.context.handleAnswerExpansionCommand({action:'toggle'});
    assert.equal(f.collapsed(1), false);
  }
  f.bubble(1).focus();
  for (const flag of ['answerShortcutComposing','answerShortcutRepeat']) {
    f.run(`${flag} = true`); f.context.handleAnswerExpansionCommand({action:'toggle'}); assert.equal(f.collapsed(1), false); f.run(`${flag} = false`);
  }
  f.document.hasFocus = () => false; f.context.handleAnswerExpansionCommand({action:'toggle'}); assert.equal(f.collapsed(1),false);
  f.document.hasFocus = () => true; f.bubble(1).inert = true; f.context.handleAnswerExpansionCommand({action:'toggle'}); assert.equal(f.collapsed(1),false);
});
test('double-click expands previews and leaves expanded text selection alone', () => {
  const f = fixture(); const normal = f.event(f.body(1).querySelector('p'), 0);
  f.context.handleAnswerDoubleClick(normal); assert.equal(normal.defaultPrevented, false); assert.equal(f.renders,1);
  f.context.handleAnswerMiddleDown(f.event(f.body(1)));
  const preview = f.event(f.body(1).querySelector('p'),0); f.context.handleAnswerDoubleClick(preview);
  assert.equal(preview.defaultPrevented, true); assert.equal(f.collapsed(1),false);
});
test('native contexts at any depth carry stable message, session and revision without hiding Copy', () => {
  const f = fixture();
  for (const tag of ['h2','td','code']) {
    const data = JSON.parse(f.body(2).querySelector(tag).closest('[data-vscode-context]').dataset.vscodeContext);
    assert.equal(data.answerMessageIndex,2); assert.equal(data.answerFsPath,'/session-a'); assert.equal(data.preventDefaultContextMenuItems,undefined);
    f.context.handleAnswerExpansionCommand({action:'collapse',context:data}); assert.equal(f.collapsed(2),true);
    f.context.handleAnswerExpansionCommand({action:'expand',context:JSON.parse(f.body(2).dataset.vscodeContext)}); assert.equal(f.collapsed(2),false);
  }
  assert.equal(JSON.parse(f.body(0).dataset.vscodeContext).answerMessageIndex,0); assert.equal(f.body(3).dataset.vscodeContext,undefined);
});
test('stale session/menu revision and forged non-message indexes cannot fold another answer', () => {
  const f = fixture(); const data = JSON.parse(f.body(1).dataset.vscodeContext);
  for (const change of [{answerFsPath:'/session-b'},{answerRevision:0},{answerMessageIndex:3},{answerMessageIndex:1.5}]) {
    f.context.handleAnswerExpansionCommand({action:'collapse',context:{...data,...change}}); assert.equal(f.renders,1);
  }
});
for (const mode of ['off','auto','always']) test(`manual folding coexists with ${mode} defaults and explicit reveals`, () => {
  const f = fixture(mode); assert.equal(f.collapsed(1),mode !== 'off');
  f.context.handleAnswerMiddleDown(f.event(f.body(1))); assert.equal(f.collapsed(1),mode === 'off');
  if (!f.collapsed(1)) f.context.handleAnswerMiddleDown(f.event(f.body(1)));
  f.run('expandedMessageIndexes.add(1)'); f.render(); assert.equal(f.collapsed(1),false);
});
test('manual short answers and detail mode still fold without changing user defaults', () => {
  const f = fixture(); f.items[1].text = 'Short answer'; f.run('showDetails = true'); f.render();
  f.context.handleAnswerMiddleDown(f.event(f.body(1))); assert.equal(f.collapsed(1),true); assert.equal(f.collapsed(0),false);
});
test('deeply scrolled collapse shows the preview, and expansion preserves its viewport offset', () => {
  const f = fixture(); f.scrollRoot.scrollTop = 15000;
  f.context.handleAnswerMiddleDown(f.event(f.body(1).querySelector('code')));
  let offset = f.bubble(1).getBoundingClientRect().top - 40;
  assert.equal(offset,8); assert.equal(f.collapsed(1),true);
  f.context.handleAnswerMiddleDown(f.event(f.body(1))); assert.equal(f.collapsed(1),false);
  assert.equal(f.bubble(1).getBoundingClientRect().top - 40, offset);
});
test('already visible previews keep their position; session reset clears the selected answer', () => {
  const f = fixture(); f.scrollRoot.scrollTop = 400;
  const before = f.bubble(1).getBoundingClientRect().top;
  f.context.handleAnswerMiddleDown(f.event(f.body(1))); assert.equal(f.bubble(1).getBoundingClientRect().top,before);
  f.context.resetSessionScopedUiState();
  assert.equal(f.run('selectedAnswerMessageIndex'),null); assert.equal(f.run('manuallyCollapsedMessageIndexes.size'),0);
  assert.equal(f.sent.at(-1).focused,false);
});
test('many visible answers never change the wrong message', () => {
  const f = fixture('off',1500); f.context.handleAnswerMiddleDown(f.event(f.body(1499).querySelector('td')));
  assert.equal(f.collapsed(1499),true); assert.equal(f.collapsed(1498),false); assert.equal(f.collapsed(1500),false);
});
test('VS Code keybinding and localized native menus remain scoped and remappable', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const binding = pkg.contributes.keybindings.find(b=>b.command==='codexHistoryViewer.toggleAnswerExpansion');
  assert.equal(binding.key,'ctrl+space'); assert.match(binding.when,/activeWebviewPanelId == 'codexHistoryViewer.chat'/); assert.match(binding.when,/answerFocus/);
  assert.ok(pkg.contributes.commands.some(c=>c.command===binding.command));
  const menus = pkg.contributes.menus['webview/context']; assert.equal(menus.length,4);
  for (const menu of menus) assert.match(menu.when,/webviewSection == 'answerBody'/);
  for (const lang of ['en','ja']) {
    const locale = JSON.parse(fs.readFileSync(path.join(root,`localization/locales/${lang}.json`),'utf8'));
    assert.ok(locale.manifest['ui.command.collapseAnswer']); assert.ok(locale.manifest['ui.command.expandAnswer']);
  }
});

test('host routes commands only to the active, ready panel and validates native context', () => {
  const text = fs.readFileSync(path.join(root,'src/chat/chatPanelManager.ts'),'utf8');
  const ast = ts.createSourceFile('chatPanelManager.ts', text, ts.ScriptTarget.Latest, true);
  const methods = [];
  (function visit(n) {
    if (ts.isMethodDeclaration(n) && ['changeAnswerExpansion','publishAnswerShortcutFocus'].includes(n.name?.getText(ast))) methods.push(n.getText(ast));
    ts.forEachChild(n,visit);
  })(ast);
  const sent = [], contexts = [];
  const ctx = vm.createContext({vscode:{commands:{executeCommand:(...args)=>contexts.push(args)}}});
  vm.runInContext(ts.transpileModule(`class Bridge { ${methods.join('\n')} } globalThis.Bridge = Bridge;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const bridge = new ctx.Bridge();
  const a={active:false,webview:{postMessage:m=>sent.push(['a',m])}}, b={active:true,webview:{postMessage:m=>sent.push(['b',m])}};
  bridge.getOpenPanels=()=>[a,b]; bridge.readyByPanel=new Map([[a,true],[b,true]]);
  bridge.stateByPanel=new Map([[a,{fsPath:'/a'}],[b,{fsPath:'/b'}]]);
  bridge.answerShortcutFocusByPanel=new Map([[a,true],[b,false]]);
  bridge.changeAnswerExpansion('toggle'); assert.equal(sent.length,0);
  bridge.answerShortcutFocusByPanel.set(b,true); bridge.changeAnswerExpansion('toggle'); assert.equal(sent.at(-1)[0],'b');
  const count=sent.length;
  for (const target of [null, {},{answerFsPath:'/a',answerMessageIndex:1,answerRevision:1},{answerFsPath:'/b',answerMessageIndex:'1',answerRevision:1}]) bridge.changeAnswerExpansion('collapse',target);
  assert.equal(sent.length,count);
  bridge.changeAnswerExpansion('collapse',{answerFsPath:'/b',answerMessageIndex:1,answerRevision:1}); assert.equal(sent.length,count+1);
  bridge.publishAnswerShortcutFocus(); assert.equal(contexts.at(-1)[2],true);
  a.active=false; b.active=false; bridge.publishAnswerShortcutFocus(); assert.equal(contexts.at(-1)[2],false);
  bridge.changeAnswerExpansion('toggle'); assert.equal(sent.length,count+1);
});

for (const mode of ['off', 'auto']) test(`user questions support all controls with ${mode} folding`, () => {
  const f = fixture(mode);
  f.items[0].text = 'Long question.\n'.repeat(2000); f.render();
  if (f.collapsed(0)) f.context.handleAnswerMiddleDown(f.event(f.body(0)));
  for (const tag of ['h2', 'td', 'code']) {
    const e = f.event(f.body(0).querySelector(tag)); f.context.handleAnswerMiddleDown(e);
    assert.equal(e.defaultPrevented,true); assert.equal(f.collapsed(0),true);
    f.context.handleAnswerDoubleClick(f.event(f.body(0).querySelector('p'),0)); assert.equal(f.collapsed(0),false);
  }
  f.context.handleAnswerSelection(f.event(f.body(0),0));
  f.context.handleAnswerExpansionCommand({action:'toggle'}); assert.equal(f.collapsed(0),true);
  f.context.handleAnswerExpansionCommand({action:'toggle'}); assert.equal(f.collapsed(0),false);
  const data = JSON.parse(f.body(0).dataset.vscodeContext);
  f.context.handleAnswerExpansionCommand({action:'collapse',context:data}); assert.equal(f.collapsed(0),true);
  f.context.handleAnswerExpansionCommand({action:'expand',context:data}); assert.equal(f.collapsed(0),false);
  assert.equal(f.collapsed(1),mode !== 'off');
});
