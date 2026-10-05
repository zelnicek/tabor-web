/* Editor webu – Tábor šlapanických divadelníků
 *
 * Běží jen uvnitř lokálního editoru (python3 _editor/editor.py).
 * Server ke každému upravitelnému místu ve stránce připíše atribut:
 *   data-ed="N"      text, který jde přepsat
 *   data-ed-box="N"  kontejner, do kterého jde přidat / ubrat řádek
 *   data-ed-img="N"  fotka, kterou jde vyměnit
 * Při uložení se posílá jen to, co se opravdu změnilo, a server to vloží
 * přesně na stejné místo ve zdrojovém souboru.
 */
(function () {
	'use strict';

	const metaEl = document.getElementById('ed-meta');
	if (!metaEl || window.__ED) return;
	const META = JSON.parse(metaEl.textContent);

	const EDITABLE = '[data-ed]:not([data-ed-lock]),[data-ed-new]';
	const STRUCT_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'DT', 'DD']);
	const LOCK_TEXT = {
		shared: 'Menu a patička jsou na všech stránkách stejné, proto se tady upravit nedají.',
		dynamic: 'Tohle vyplňuje web sám (třeba odpočet nebo tlačítko sdílení) – ruční úprava by se neprojevila.',
		mismatch: 'Tenhle kousek stránky je v kódu zapsaný neobvykle, editor ho radši nechává být.'
	};

	const norm = s => s.replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim();
	const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const isEdAttr = name => name === 'contenteditable' || name === 'spellcheck' || name.startsWith('data-ed');

	/* ------------------------------------------------------------------ *
	 *  Příprava stránky
	 * ------------------------------------------------------------------ */

	// Skripty webu v editoru neběží – desktopové styly zapneme sami
	// (stejně jako původní skript webu: hned, nebo až se okno roztáhne).
	let deskCss = false;
	const enableDesktopCss = () => {
		if (deskCss || window.innerWidth < 600) return;
		document.querySelectorAll('head > link[media="screen and (min-width:37.5em)"]').forEach(l => {
			l.removeAttribute('disabled');
			l.disabled = false;
		});
		deskCss = true;
	};
	enableDesktopCss();
	window.addEventListener('resize', enableDesktopCss);

	const leaves = new Map();   // id -> { el, orig, href }
	const boxes = new Map();    // id -> { el, dirty }
	const images = new Map();   // id -> { el, pending }

	document.querySelectorAll('[data-ed]').forEach(el => {
		const id = +el.dataset.ed;
		if (el.dataset.edLock) return;
		if (norm(el.textContent) !== META.texts[id]) {
			el.dataset.edLock = 'mismatch';
			return;
		}
		el.contentEditable = 'true';
		el.spellcheck = false;
		leaves.set(id, { el, orig: el.innerHTML, href: el.tagName === 'A' ? el.getAttribute('href') : null });
	});
	document.querySelectorAll('[data-ed-box]').forEach(el => {
		const id = +el.dataset.edBox;
		if (norm(el.textContent) !== META.boxTexts[id]) {
			el.removeAttribute('data-ed-box');
			return;
		}
		boxes.set(id, { el, marked: false, orig: null });
	});
	document.querySelectorAll('[data-ed-img]').forEach(el => images.set(+el.dataset.edImg, { el, pending: null }));

	// Texty schované v rozbalovačkách (např. odpovědi v „Otázkách a odpovědích“)
	// web otevírá skriptem, který v editoru neběží – rozbalíme je natrvalo.
	function unfoldHidden() {
		leaves.forEach(r => {
			for (let n = r.el.parentElement; n && n !== document.body; n = n.parentElement) {
				const cs = getComputedStyle(n);
				if (cs.display === 'none') n.setAttribute('data-ed-unfold', 'display');
				else if (cs.overflowY !== 'visible' && n.getBoundingClientRect().height < 2) n.setAttribute('data-ed-unfold', 'height');
				else if (cs.visibility === 'hidden' || cs.opacity === '0') n.setAttribute('data-ed-unfold', 'show');
			}
		});
	}
	unfoldHidden();

	/* ------------------------------------------------------------------ *
	 *  Ovládací prvky (ve vlastním Shadow DOM, styly webu na ně nesáhnou)
	 * ------------------------------------------------------------------ */

	const host = document.createElement('div');
	host.id = '__ed-ui';
	document.body.appendChild(host);
	const ui = host.attachShadow({ mode: 'open' });
	ui.innerHTML = `
<style>
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
[hidden] { display: none !important; }
button { font: inherit; font-size: 14px; border: 0; border-radius: 9px; padding: 8px 13px; cursor: pointer; background: #2b3b4e; color: #fff; white-space: nowrap; line-height: 1.2; }
button:hover { background: #3a4e65; }
button:disabled { opacity: .4; cursor: default; }
button.primary { background: #0f6cb6; } button.primary:hover:not(:disabled) { background: #1580d4; }
button.go { background: #1f8a3b; } button.go:hover:not(:disabled) { background: #26a248; }
button.icon { width: 36px; padding: 8px 0; text-align: center; }

.bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 2147483000;
  width: min(1100px, calc(100vw - 20px)); display: flex; align-items: center; gap: 7px; padding: 8px 9px;
  background: #172433; color: #fff; border-radius: 14px; box-shadow: 0 10px 34px rgba(0,0,0,.38); font-size: 14px; }
.brand { font-weight: 700; white-space: nowrap; padding: 0 4px 0 6px; }
select.pages { font: inherit; font-size: 14px; max-width: 250px; padding: 7px 8px; border-radius: 9px; border: 0; background: #2b3b4e; color: #fff; cursor: pointer; }
.status { color: #c6d2de; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; padding: 0 4px; }
.status b { color: #fff; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #facc15; margin-right: 7px; vertical-align: 0; }
.spacer { flex: 1; }
.badge { display: inline-block; min-width: 20px; padding: 1px 6px; margin-left: 7px; border-radius: 10px; background: #fff; color: #1f8a3b; font-weight: 800; font-size: 12px; text-align: center; }

.tb { position: fixed; z-index: 2147483001; display: flex; align-items: center; gap: 1px; padding: 4px;
  background: #fff; border: 1px solid #d3dbe4; border-radius: 11px; box-shadow: 0 8px 26px rgba(16,30,50,.2); }
.tb button { background: transparent; color: #1d2b3a; padding: 6px 9px; border-radius: 7px; font-size: 14px; }
.tb button:hover { background: #eaf1f8; }
.tb .sep { width: 1px; height: 22px; background: #e1e7ee; margin: 0 4px; }
.tb .sw { width: 20px; height: 20px; padding: 0; margin: 0 2px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 1px #c3cdd8, inset 0 0 0 2px #fff; }
.tb .sw:hover { background: var(--c); transform: scale(1.12); }
.tb .sw-none { background: linear-gradient(135deg, #fff 44%, #d92d20 44%, #d92d20 56%, #fff 56%); }
.tb .sw-none:hover { background: linear-gradient(135deg, #fff 44%, #d92d20 44%, #d92d20 56%, #fff 56%); }

.imgbtn { position: fixed; z-index: 2147483001; background: #0f6cb6; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
.imgbtn:hover { background: #1580d4; }
.tip { position: fixed; z-index: 2147483002; max-width: 330px; padding: 8px 11px; background: #1d2b3a; color: #fff;
  border-radius: 8px; font-size: 13px; line-height: 1.45; pointer-events: none; box-shadow: 0 6px 18px rgba(0,0,0,.25); }

.toasts { position: fixed; left: 50%; bottom: 80px; transform: translateX(-50%); z-index: 2147483003;
  display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
.toast { pointer-events: auto; background: #1d2b3a; color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 14px;
  box-shadow: 0 8px 22px rgba(0,0,0,.28); display: flex; gap: 12px; align-items: center; transition: opacity .3s, transform .3s; }
.toast button { background: #33475e; padding: 5px 10px; font-size: 13px; }
.toast.out { opacity: 0; transform: translateY(8px); }

.ov { position: fixed; inset: 0; z-index: 2147483004; background: rgba(15,25,38,.55); display: flex;
  align-items: center; justify-content: center; padding: 20px; }
.dlg { width: min(540px, 100%); max-height: calc(100vh - 40px); overflow: auto; background: #fff; color: #1d2b3a;
  border-radius: 14px; padding: 22px 22px 18px; box-shadow: 0 22px 60px rgba(0,0,0,.35); font-size: 15px; line-height: 1.5; }
.dlg h2 { margin: 0 0 10px; font-size: 20px; line-height: 1.25; }
.dlg p { margin: 0 0 10px; }
.dlg ul { margin: 4px 0 12px; padding-left: 22px; }
.dlg li { margin-bottom: 4px; }
.dlg label { display: block; font-weight: 600; margin: 6px 0; }
.dlg input[type=text] { width: 100%; margin-top: 6px; padding: 10px 12px; border: 1px solid #c3cdd8; border-radius: 8px; font: inherit; font-weight: 400; }
.dlg input[type=text]:focus { outline: 2px solid #0f6cb6; border-color: transparent; }
.dlg .hint { color: #5c6b7d; font-size: 13px; }
.dlg .ok { color: #1f8a3b; font-weight: 700; }
.dlg .warn { background: #fdf3e3; border-left: 4px solid #e6c68a; padding: 10px 12px; border-radius: 6px; }
.dlg details { margin-top: 10px; font-size: 12px; color: #5c6b7d; }
.dlg pre { white-space: pre-wrap; word-break: break-word; background: #f4f7fa; padding: 8px; border-radius: 6px; max-height: 180px; overflow: auto; }
.dlg kbd { font: 12px ui-monospace, Menlo, monospace; background: #eef2f6; border: 1px solid #d3dbe4; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }
.dlg-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }
.dlg-btns .left { margin-right: auto; }
.dlg button { background: #eef2f6; color: #1d2b3a; }
.dlg button:hover:not(:disabled) { background: #e1e8ef; }
.dlg button.primary { background: #0f6cb6; color: #fff; }
.dlg button.go { background: #1f8a3b; color: #fff; }
.dlg button.danger { background: #fdecea; color: #b42318; }
.dlg button.danger:hover:not(:disabled) { background: #fadad6; }
.spin { display: inline-block; width: 16px; height: 16px; border: 2px solid #c3cdd8; border-top-color: #0f6cb6; border-radius: 50%;
  animation: sp .8s linear infinite; vertical-align: -3px; margin-right: 9px; }
@keyframes sp { to { transform: rotate(360deg); } }

.bye { position: fixed; inset: 0; z-index: 2147483005; background: rgba(244,247,250,.97); display: flex; align-items: center;
  justify-content: center; text-align: center; color: #1d2b3a; padding: 24px; }
.bye div { max-width: 460px; font-size: 16px; line-height: 1.55; }
.bye h2 { font-size: 26px; margin: 0 0 10px; color: #1f8a3b; }
</style>

<div class="bar" role="toolbar" aria-label="Editor webu">
  <div class="brand">✏️ Úprava webu</div>
  <select class="pages" title="Přejít na jinou stránku"><option>…</option></select>
  <div class="status"></div>
  <div class="spacer"></div>
  <button class="b-discard" title="Zahodit neuložené změny na téhle stránce">Zahodit</button>
  <button class="b-save primary" title="Uložit změny (⌘S)">💾 Uložit</button>
  <button class="b-publish go" title="Poslat uložené změny na www.taborslapanice.cz">🚀 Zveřejnit</button>
  <button class="b-preview icon" title="Náhled stránky tak, jak ji uvidí návštěvníci">👁</button>
  <button class="b-help icon" title="Nápověda">?</button>
  <button class="b-quit icon" title="Ukončit editor">⏻</button>
</div>

<div class="tb" hidden>
  <button data-cmd="bold" title="Tučně (⌘B)"><b>B</b></button>
  <button data-cmd="italic" title="Kurzíva (⌘I)"><i>I</i></button>
  <button data-cmd="underline" title="Podtržení (⌘U)"><u>U</u></button>
  <span class="sep"></span>
  <button class="sw" data-color="#d92d20" style="--c:#d92d20" title="Červená"></button>
  <button class="sw" data-color="#0f6cb6" style="--c:#0f6cb6" title="Modrá"></button>
  <button class="sw" data-color="#1f8a3b" style="--c:#1f8a3b" title="Zelená"></button>
  <button class="sw sw-none" data-color="inherit" title="Původní barva"></button>
  <span class="sep"></span>
  <button data-act="link" title="Vložit nebo upravit odkaz">🔗 Odkaz</button>
  <button data-cmd="removeFormat" title="Zrušit tučné písmo, barvy a podobně u vybraného textu">⌫</button>
  <span class="sep st"></span>
  <button class="st" data-act="dup" title="Vložit pod tenhle řádek jeho kopii">⧉ Kopie</button>
  <button class="st" data-act="add" title="Vložit pod tenhle řádek nový, prázdný">＋ Nový</button>
  <button class="st" data-act="del" title="Smazat celý tenhle řádek">🗑</button>
  <span class="sep rv"></span>
  <button class="rv" data-act="revert" title="Vrátit text do podoby před úpravou">↺ Původní</button>
</div>

<button class="imgbtn" hidden>🖼 Vyměnit fotku</button>
<div class="tip" hidden></div>
<div class="toasts"></div>
<div class="ov" hidden></div>
<input class="file" type="file" accept="image/*" hidden>
`;

	const $ = sel => ui.querySelector(sel);
	const bar = $('.bar'), tb = $('.tb'), imgBtn = $('.imgbtn'), tip = $('.tip');
	const toastsEl = $('.toasts'), ov = $('.ov'), fileInput = $('.file');
	const statusEl = $('.status'), pagesSel = $('.pages');
	const saveBtn = $('.b-save'), discardBtn = $('.b-discard'), publishBtn = $('.b-publish');

	/* ------------------------------------------------------------------ *
	 *  Stav a pomocné funkce
	 * ------------------------------------------------------------------ */

	let active = null;            // právě upravovaný prvek
	let imgTarget = null;         // fotka pod myší
	let modalOpen = false;
	let busy = false;
	let skipUnloadPrompt = false;
	let pendingCount = 0;
	const undoStack = [];

	const inUI = e => e.composedPath().includes(host);
	const editableOf = node => {
		const el = node && (node.nodeType === 1 ? node : node.parentElement);
		return el && el.closest ? el.closest(EDITABLE) : null;
	};
	const leafRec = el => (el && el.dataset.ed !== undefined ? leaves.get(+el.dataset.ed) : null);
	const isDirtyLeaf = r => r.el.innerHTML !== r.orig || (r.href !== null && r.el.getAttribute('href') !== r.href);
	const canStruct = el => !!el && STRUCT_TAGS.has(el.tagName) && !!el.parentElement
		&& el.parentElement.hasAttribute('data-ed-box') && boxes.has(+el.parentElement.dataset.edBox);

	// Kontejner je změněný, jen když se do něj přidávalo / mazalo a jeho obsah
	// se opravdu liší od původního (Vrátit po smazání tedy změnu zruší).
	const isBoxDirty = b => b.marked && b.el.isConnected && cleanInner(b.el, false) !== b.orig;

	function dirtyTopBoxes() {
		const d = [...boxes.entries()].filter(([, b]) => {
			const dirty = isBoxDirty(b);
			b.el.toggleAttribute('data-ed-dirty', dirty);
			return dirty;
		});
		return d.filter(([, b]) => !d.some(([, o]) => o !== b && o.el.contains(b.el)));
	}

	function changeCount() {
		const top = dirtyTopBoxes();
		const inTop = el => top.some(([, b]) => b.el.contains(el));
		let n = top.length;
		leaves.forEach(r => { if (r.el.isConnected && !inTop(r.el) && isDirtyLeaf(r)) n++; });
		images.forEach(r => { if (r.pending && r.el.isConnected && !inTop(r.el)) n++; });
		return n;
	}

	function updateStatus() {
		const n = changeCount();
		if (n) statusEl.innerHTML = `<i class="dot"></i>Neuloženo: <b>${n}</b>`;
		else if (pendingCount) statusEl.textContent = 'Uloženo, ještě nezveřejněno';
		else statusEl.textContent = 'Klikni na text a piš';
		saveBtn.disabled = !n;
		discardBtn.disabled = !n;
		publishBtn.innerHTML = '🚀 Zveřejnit' + (pendingCount ? `<span class="badge">${pendingCount}</span>` : '');
	}

	function refreshDirty(el) {
		const r = leafRec(el);
		if (r) el.toggleAttribute('data-ed-dirty', isDirtyLeaf(r));
		updateStatus();
		if (el === active) updateToolbar();
	}

	/* ------------------------------------------------------------------ *
	 *  Komunikace se serverem
	 * ------------------------------------------------------------------ */

	async function api(name, body, headers, raw) {
		const opt = { method: body === undefined ? 'GET' : 'POST', headers: Object.assign({ 'X-Editor-Token': META.token }, headers || {}) };
		if (body !== undefined) {
			if (raw) {
				opt.body = body;
				opt.headers['Content-Type'] = body.type || 'application/octet-stream';
			} else {
				opt.body = JSON.stringify(body);
				opt.headers['Content-Type'] = 'application/json';
			}
		}
		try {
			const r = await fetch('/__editor__/api/' + name, opt);
			const data = await r.json().catch(() => ({ ok: false, error: 'Neočekávaná odpověď editoru (' + r.status + ').' }));
			if (!r.ok && data.ok !== false) data.ok = false;
			return data;
		} catch (err) {
			return { ok: false, offline: true, error: 'Editor neběží. Spusť ho znovu dvojklikem na „Upravit web“ (neuložený text si předtím zkopíruj).' };
		}
	}

	async function refreshPending() {
		const res = await api('pending');
		if (res.ok) {
			pendingCount = res.items.length || (res.ahead ? 1 : 0);
			updateStatus();
		}
		return res;
	}

	/* ------------------------------------------------------------------ *
	 *  Dialogy a oznámení
	 * ------------------------------------------------------------------ */

	function toast(text, actionLabel, action, ms) {
		const t = document.createElement('div');
		t.className = 'toast';
		t.innerHTML = `<span>${esc(text)}</span>` + (actionLabel ? `<button>${esc(actionLabel)}</button>` : '');
		if (actionLabel) {
			t.querySelector('button').addEventListener('mousedown', e => e.preventDefault());
			t.querySelector('button').addEventListener('click', () => { action(); t.remove(); });
		}
		toastsEl.appendChild(t);
		const life = ms || (actionLabel ? 6500 : 3500);
		setTimeout(() => t.classList.add('out'), life);
		setTimeout(() => t.remove(), life + 350);
	}

	// openModal({title, html, buttons:[{label, value, kind, left}]}) -> {done, close, setBody, setButtons}
	function openModal(opts) {
		let resolve;
		const done = new Promise(r => { resolve = r; });
		ov.innerHTML = '<div class="dlg" role="dialog" aria-modal="true"><h2></h2><div class="dlg-body"></div><div class="dlg-btns"></div></div>';
		ov.querySelector('h2').textContent = opts.title || '';
		const bodyEl = ov.querySelector('.dlg-body'), btnsEl = ov.querySelector('.dlg-btns');
		let finished = false;

		const fields = () => {
			const f = {};
			ov.querySelectorAll('input[name]').forEach(i => { f[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
			return f;
		};
		const close = value => {
			if (finished) return;
			finished = true;
			const f = fields();
			ov.hidden = true;
			ov.innerHTML = '';
			modalOpen = false;
			document.removeEventListener('keydown', onKey, true);
			resolve({ value: value === undefined ? null : value, fields: f });
		};
		const setBody = h => { bodyEl.innerHTML = h || ''; };
		const setTitle = t => { ov.querySelector('h2').textContent = t || ''; };
		const setButtons = list => {
			btnsEl.innerHTML = '';
			(list || []).forEach(b => {
				const el = document.createElement('button');
				el.textContent = b.label;
				el.className = (b.kind || '') + (b.left ? ' left' : '');
				el.addEventListener('click', () => close(b.value));
				btnsEl.appendChild(el);
			});
		};
		const onKey = e => {
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
			if (e.key === 'Enter' && e.composedPath()[0] && e.composedPath()[0].tagName === 'INPUT') {
				const primary = btnsEl.querySelector('.primary, .go');
				if (primary) { e.preventDefault(); primary.click(); }
			}
		};
		setBody(opts.html);
		setButtons(opts.buttons);
		ov.hidden = false;
		modalOpen = true;
		document.addEventListener('keydown', onKey, true);
		ov.onclick = e => { if (e.target === ov && opts.dismissable !== false) close(null); };
		const input = ov.querySelector('input[type=text]');
		if (input) setTimeout(() => { input.focus(); input.select(); }, 30);
		return { done, close, setBody, setButtons, setTitle };
	}

	function message(title, text, detail) {
		return openModal({
			title,
			html: `<p>${esc(text)}</p>` + (detail ? `<details><summary>Podrobnosti</summary><pre>${esc(detail)}</pre></details>` : ''),
			buttons: [{ label: 'Rozumím', value: 'ok', kind: 'primary' }]
		}).done;
	}

	/* ------------------------------------------------------------------ *
	 *  Plovoucí panel nad upravovaným textem
	 * ------------------------------------------------------------------ */

	function setActive(el) {
		if (active === el) { positionToolbar(); return; }
		if (active && active.isConnected) {
			active.spellcheck = false;
			syncContactLinks(active);
			refreshDirty(active);
		}
		active = el;
		if (el) {
			el.spellcheck = true;
			tb.hidden = false;
			updateToolbar();
		} else {
			tb.hidden = true;
		}
	}

	function updateToolbar() {
		if (!active) return;
		const struct = canStruct(active);
		tb.querySelectorAll('.st').forEach(b => { b.hidden = !struct; });
		if (struct) {
			tb.querySelector('[data-act="add"]').textContent = active.tagName === 'LI' ? '＋ Položka' : '＋ Odstavec';
		}
		const r = leafRec(active);
		const dirty = !!(r && isDirtyLeaf(r));
		tb.querySelectorAll('.rv').forEach(b => { b.hidden = !dirty; });
		positionToolbar();
	}

	function positionToolbar() {
		if (!active || tb.hidden) return;
		const r = active.getBoundingClientRect();
		const w = tb.offsetWidth, h = tb.offsetHeight;
		let top = r.top - h - 12;
		if (top < 8) top = r.bottom + 12;
		if (top + h > window.innerHeight - 80) top = Math.max(8, window.innerHeight - 80 - h);
		const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
		tb.style.top = top + 'px';
		tb.style.left = left + 'px';
	}

	tb.addEventListener('mousedown', e => e.preventDefault());   // výběr textu zůstane, kde byl
	tb.addEventListener('click', e => {
		const b = e.target.closest('button');
		if (!b || !active) return;
		if (b.dataset.cmd) exec(b.dataset.cmd);
		else if (b.dataset.color) exec('foreColor', b.dataset.color, true);
		else if (b.dataset.act === 'link') openLinkDialog();
		else if (b.dataset.act === 'dup') addBelow(true);
		else if (b.dataset.act === 'add') addBelow(false);
		else if (b.dataset.act === 'del') removeActive();
		else if (b.dataset.act === 'revert') revertActive();
	});

	function ensureSelection(el) {
		const sel = getSelection();
		if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
			const r = document.createRange();
			r.selectNodeContents(el);
			r.collapse(false);
			sel.removeAllRanges();
			sel.addRange(r);
		}
	}

	function exec(cmd, value, css) {
		const el = active;
		if (!el) return;
		el.focus();
		ensureSelection(el);
		document.execCommand('styleWithCSS', false, !!css);
		document.execCommand(cmd, false, value);
		document.execCommand('styleWithCSS', false, false);
		refreshDirty(el);
	}

	function revertActive() {
		const r = leafRec(active);
		if (!r) return;
		r.el.innerHTML = r.orig;
		if (r.href !== null) r.el.setAttribute('href', r.href);
		refreshDirty(r.el);
		toast('Text vrácen do původní podoby.');
	}

	/* ------------------------------------------------------------------ *
	 *  Odkazy
	 * ------------------------------------------------------------------ */

	function normalizeUrl(v) {
		v = (v || '').trim();
		if (!v) return null;
		if (/^(javascript|data|vbscript):/i.test(v)) return null;
		if (/^(https?:|mailto:|tel:|\/|\.\.?\/|#)/i.test(v)) return v;
		if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) return 'mailto:' + v;
		const d = v.replace(/[\s\-()]/g, '');
		if (/^\+?\d{9,15}$/.test(d)) return 'tel:' + (d.startsWith('+') ? d : (d.length === 9 ? '+420' + d : d));
		if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return 'https://' + v;
		return v;
	}

	function setLinkTarget(a, url) {
		const external = /^https?:/i.test(url) && !/^https?:\/\/(www\.)?taborslapanice\.cz/i.test(url);
		if (external) {
			a.setAttribute('target', '_blank');
			a.setAttribute('rel', 'noopener noreferrer');
		}
	}

	async function openLinkDialog() {
		const el = active;
		if (!el) return;
		const sel = getSelection();
		const range = sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
		let a = null;
		if (range) {
			let n = range.commonAncestorContainer;
			if (n.nodeType !== 1) n = n.parentElement;
			a = n.closest('a');
			if (a && a !== el && !el.contains(a)) a = null;
		}
		if (!a && el.tagName === 'A') a = el;
		const current = a ? a.getAttribute('href') || '' : '';
		const shown = current.replace(/^mailto:/i, '').replace(/^tel:/i, '');
		const m = openModal({
			title: a ? 'Upravit odkaz' : 'Vložit odkaz',
			html: `<label>Kam má odkaz vést
				<input type="text" name="url" value="${esc(shown)}" placeholder="např. www.zonerama.com/…, info@taborslapanice.cz nebo 731 507 034"></label>
				<p class="hint">Webová adresa, e-mail nebo telefon – editor sám pozná, o co jde.${!a && range && range.collapsed ? ' Když nemáš vybraný žádný text, vloží se odkaz jako text.' : ''}</p>`,
			buttons: [
				a && a !== el ? { label: 'Odebrat odkaz', value: 'remove', kind: 'danger', left: true } : null,
				current ? { label: 'Otevřít', value: 'open', left: !(a && a !== el) } : null,
				{ label: 'Zrušit', value: null },
				{ label: 'Uložit odkaz', value: 'save', kind: 'primary' }
			].filter(Boolean)
		});
		const res = await m.done;
		if (!res.value) { el.focus(); return; }
		if (res.value === 'open') {
			const u = normalizeUrl(res.fields.url) || current;
			try { window.open(new URL(u, location.href).href, '_blank', 'noopener'); } catch (err) { /* nic */ }
			return;
		}
		el.focus();
		if (range) { sel.removeAllRanges(); sel.addRange(range); }
		if (res.value === 'remove' && a) {
			a.replaceWith(...a.childNodes);
			refreshDirty(el);
			return;
		}
		const url = normalizeUrl(res.fields.url);
		if (!url) { toast('Tohle nevypadá jako platná adresa.'); return; }
		if (a) {
			a.setAttribute('href', url);
			setLinkTarget(a, url);
		} else if (range && !range.collapsed) {
			document.execCommand('createLink', false, url);
			el.querySelectorAll('a[href]').forEach(x => { if (x.getAttribute('href') === url) setLinkTarget(x, url); });
		} else {
			const text = url.replace(/^mailto:|^tel:/i, '').replace(/^https?:\/\//i, '');
			document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(text)}</a>`);
			el.querySelectorAll('a[href]').forEach(x => { if (x.getAttribute('href') === url) setLinkTarget(x, url); });
		}
		refreshDirty(el);
	}

	// Když se přepíše viditelné číslo nebo e-mail, ať se změní i kam odkaz vede.
	function syncContactLinks(el) {
		const links = [...el.querySelectorAll('a[href]')];
		if (el.tagName === 'A' && el.hasAttribute('href')) links.push(el);
		links.forEach(a => {
			const href = a.getAttribute('href') || '';
			const text = a.textContent.trim();
			if (/^tel:/i.test(href)) {
				const d = text.replace(/[^\d+]/g, '');
				if (/^\+?\d{9,15}$/.test(d)) {
					const tel = 'tel:' + (d.startsWith('+') ? d : (d.length === 9 ? '+420' + d : d));
					if (tel !== href) a.setAttribute('href', tel);
				}
			} else if (/^mailto:/i.test(href)) {
				if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(text) && href.slice(7).split('?')[0] !== text) {
					a.setAttribute('href', 'mailto:' + text);
				}
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 *  Přidání / kopie / smazání řádku
	 * ------------------------------------------------------------------ */

	function scrub(root) {
		[root, ...root.querySelectorAll('*')].forEach(n => {
			[...n.attributes].forEach(a => { if (isEdAttr(a.name) || a.name === 'id') n.removeAttribute(a.name); });
		});
	}

	function placeCaretEnd(el) {
		const r = document.createRange();
		r.selectNodeContents(el);
		r.collapse(false);
		const s = getSelection();
		s.removeAllRanges();
		s.addRange(r);
	}

	// Volá se PŘED změnou kontejneru, aby šlo porovnat s původním obsahem.
	function markBox(box) {
		const b = boxes.get(+box.dataset.edBox);
		if (b && !b.marked) {
			b.orig = cleanInner(box, false);
			b.marked = true;
		}
	}

	function addBelow(copy) {
		const el = active;
		if (!canStruct(el)) return;
		const box = el.parentElement;
		let n;
		if (copy) {
			n = el.cloneNode(true);
			scrub(n);
		} else {
			const tag = /^H\d$/.test(el.tagName) ? 'p' : el.tagName.toLowerCase();
			n = document.createElement(tag);
			if (tag === el.tagName.toLowerCase()) {
				[...el.attributes].forEach(a => { if (!isEdAttr(a.name) && a.name !== 'id') n.setAttribute(a.name, a.value); });
			}
		}
		n.setAttribute('data-ed-new', '');
		n.contentEditable = 'true';
		n.spellcheck = false;
		markBox(box);
		el.after(n);
		updateStatus();
		undoStack.push({ type: 'add', node: n });
		n.focus();
		placeCaretEnd(n);
		toast(copy ? 'Kopie vložena – teď ji přepiš.' : 'Nový řádek vložen – piš.', 'Vrátit', undoLast);
	}

	function removeActive() {
		const el = active;
		if (!canStruct(el)) return;
		const box = el.parentElement;
		const next = el.nextSibling;
		setActive(null);
		markBox(box);
		el.remove();
		updateStatus();
		undoStack.push({ type: 'del', node: el, box, next });
		toast('Řádek smazán.', 'Vrátit', undoLast);
	}

	function undoLast() {
		const u = undoStack.pop();
		if (!u) return;
		if (u.type === 'add') u.node.remove();
		else u.box.insertBefore(u.node, u.next && u.next.parentNode === u.box ? u.next : null);
		updateStatus();
	}

	/* ------------------------------------------------------------------ *
	 *  Fotky
	 * ------------------------------------------------------------------ */

	function prepareImage(file) {
		return new Promise((resolve, reject) => {
			const url = URL.createObjectURL(file);
			const im = new Image();
			im.onload = () => {
				URL.revokeObjectURL(url);
				const MAX = 2000;
				let w = im.naturalWidth, h = im.naturalHeight;
				if (!w || !h) { reject(new Error('empty')); return; }
				const scale = Math.min(1, MAX / Math.max(w, h));
				const keepPng = file.type === 'image/png';
				if (scale === 1 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && file.size <= 1.5e6) {
					resolve({ blob: file, width: w, height: h });
					return;
				}
				w = Math.round(w * scale);
				h = Math.round(h * scale);
				const c = document.createElement('canvas');
				c.width = w;
				c.height = h;
				const ctx = c.getContext('2d');
				if (!keepPng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
				ctx.drawImage(im, 0, 0, w, h);
				c.toBlob(b => (b ? resolve({ blob: b, width: w, height: h }) : reject(new Error('toBlob'))),
					keepPng ? 'image/png' : 'image/jpeg', 0.86);
			};
			im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
			im.src = url;
		});
	}

	async function replaceImage(img, file) {
		if (!img || !file) return false;
		const rec = images.get(+img.dataset.edImg);
		if (!rec) return false;
		let prepared;
		try {
			prepared = await prepareImage(file);
		} catch (err) {
			await message('Fotku se nepodařilo otevřít',
				'Tenhle formát fotky prohlížeč neumí přečíst (často jde o HEIC z iPhonu). Ulož ji prosím jako JPG a zkus to znovu.');
			return false;
		}
		toast('Nahrávám fotku…');
		const res = await api('upload', prepared.blob, { 'X-File-Name': encodeURIComponent(file.name || 'foto') }, true);
		if (!res.ok) { await message('Fotku se nepodařilo nahrát', res.error, res.detail); return false; }
		const rel = '../'.repeat(META.depth) + res.path;
		const pic = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
		if (pic) pic.querySelectorAll('source').forEach(s => s.remove());
		img.removeAttribute('srcset');
		img.removeAttribute('sizes');
		img.setAttribute('src', rel);
		img.setAttribute('width', prepared.width);
		img.setAttribute('height', prepared.height);
		img.setAttribute('data-ed-dirty', '');
		rec.pending = { src: rel, width: prepared.width, height: prepared.height };
		updateStatus();
		toast('Fotka vyměněna – nezapomeň uložit.');
		return true;
	}

	function showImgBtn(img) {
		const r = img.getBoundingClientRect();
		if (r.width < 60 || r.height < 40 || r.bottom < 0 || r.top > window.innerHeight) { imgBtn.hidden = true; return; }
		imgBtn.hidden = false;
		const top = Math.max(r.top, 8) + 10;
		imgBtn.style.top = top + 'px';
		imgBtn.style.left = Math.max(8, r.right - imgBtn.offsetWidth - 10) + 'px';
	}

	imgBtn.addEventListener('click', () => {
		if (!imgTarget) return;
		fileInput.value = '';
		fileInput.click();
	});
	fileInput.addEventListener('change', () => {
		const f = fileInput.files && fileInput.files[0];
		if (f && imgTarget) replaceImage(imgTarget, f);
	});

	/* ------------------------------------------------------------------ *
	 *  Uložení
	 * ------------------------------------------------------------------ */

	function cleanInner(el, inline) {
		const c = el.cloneNode(true);
		c.querySelectorAll('*').forEach(n => {
			[...n.attributes].forEach(a => { if (isEdAttr(a.name)) n.removeAttribute(a.name); });
		});
		if (inline) {   // případné bloky, které vložil prohlížeč, převést na řádky
			c.querySelectorAll('div, p').forEach(b => {
				const frag = document.createDocumentFragment();
				if (b.previousSibling) frag.appendChild(document.createElement('br'));
				while (b.firstChild) frag.appendChild(b.firstChild);
				b.replaceWith(frag);
			});
		}
		let h = c.innerHTML;
		if (h === '<br>') h = '';
		return h;
	}

	function buildPayload() {
		const p = { path: META.path, hash: META.hash, leaves: [], leafAttrs: [], boxes: [], images: [] };
		const top = dirtyTopBoxes();
		const inTop = el => top.some(([, b]) => b.el.contains(el));
		top.forEach(([id, b]) => p.boxes.push({ id, html: cleanInner(b.el, false) }));
		leaves.forEach((r, id) => {
			if (!r.el.isConnected || inTop(r.el)) return;
			if (r.el.innerHTML !== r.orig) p.leaves.push({ id, html: cleanInner(r.el, true) });
			if (r.href !== null && r.el.getAttribute('href') !== r.href) p.leafAttrs.push({ id, href: r.el.getAttribute('href') });
		});
		images.forEach((r, id) => {
			if (r.pending && r.el.isConnected && !inTop(r.el)) p.images.push(Object.assign({ id }, r.pending));
		});
		return (p.leaves.length || p.leafAttrs.length || p.boxes.length || p.images.length) ? p : null;
	}

	// Vrací true, když je všechno uložené. resume = co udělat po případném načtení stránky znovu.
	async function save(opts) {
		opts = opts || {};
		if (busy) return false;
		if (active) syncContactLinks(active);
		const payload = buildPayload();
		if (!payload) {
			if (!opts.quiet) toast('Nic se nezměnilo.');
			return true;
		}
		busy = true;
		statusEl.innerHTML = '<span class="spin"></span>Ukládám…';
		const res = await api('save', payload);
		busy = false;
		if (!res.ok) {
			updateStatus();
			await message('Uložení se nepovedlo', res.error, res.detail);
			return false;
		}
		if (payload.boxes.length && !opts.noReload) {
			// Přibyly nebo ubyly řádky – stránku načteme znovu, ať editor zná novou podobu.
			try {
				sessionStorage.setItem('ed-scroll:' + META.path, String(window.scrollY));
				sessionStorage.setItem('ed-toast', 'Uloženo ✓');
				if (opts.resume) sessionStorage.setItem('ed-resume', opts.resume);
			} catch (err) { /* nevadí */ }
			skipUnloadPrompt = true;
			location.reload();
			return false;
		}
		META.hash = res.hash;
		leaves.forEach(r => {
			r.orig = r.el.innerHTML;
			if (r.href !== null) r.href = r.el.getAttribute('href');
			r.el.removeAttribute('data-ed-dirty');
		});
		images.forEach(r => {
			if (r.pending) { r.pending = null; r.el.removeAttribute('data-ed-dirty'); }
		});
		updateStatus();
		if (active) updateToolbar();
		toast('Uloženo ✓');
		refreshPending();
		return true;
	}

	/* ------------------------------------------------------------------ *
	 *  Zveřejnění, zahození, konec
	 * ------------------------------------------------------------------ */

	async function publishFlow() {
		if (changeCount()) {
			const r = await openModal({
				title: 'Nejdřív uložit?',
				html: '<p>Na téhle stránce máš neuložené změny. Mají se uložit a zveřejnit spolu s ostatními?</p>',
				buttons: [{ label: 'Zpět', value: null }, { label: 'Uložit a pokračovat', value: 'save', kind: 'primary' }]
			}).done;
			if (!r.value) return;
			const ok = await save({ resume: 'publish' });
			if (!ok) return;
		}
		const pend = await refreshPending();
		if (!pend.ok) { await message('Něco se nepovedlo', pend.error, pend.detail); return; }
		if (!pend.items.length && !pend.ahead) {
			await message('Není co zveřejnit', 'Všechny uložené úpravy už jsou na webu.');
			return;
		}
		const list = pend.items.map(i => `<li>${esc(i.label)}</li>`).join('')
			|| '<li>Úpravy, které se minule nepodařilo odeslat</li>';
		const m = openModal({
			title: 'Zveřejnit na web?',
			html: `<p>Na <b>www.taborslapanice.cz</b> se pošlou tyhle uložené úpravy:</p><ul>${list}</ul>
				<p class="hint">Na webu se objeví obvykle do 1–2 minut.</p>`,
			buttons: [
				pend.items.length ? { label: 'Zahodit tyto úpravy…', value: 'discard', kind: 'danger', left: true } : null,
				{ label: 'Zpět', value: null },
				{ label: '🚀 Zveřejnit', value: 'go', kind: 'go' }
			].filter(Boolean)
		});
		const r = await m.done;
		if (r.value === 'discard') return discardFlow(pend);
		if (r.value !== 'go') return;
		await doPublish(pend);
	}

	async function doPublish(pend) {
		const m = openModal({
			title: 'Zveřejňuji…',
			html: '<p><span class="spin"></span>Posílám úpravy na GitHub. Chvilku to trvá, nezavírej prosím okno.</p>',
			buttons: [],
			dismissable: false
		});
		const res = await api('publish', { paths: pend.items.map(i => i.path) });
		if (res.ok) {
			m.setTitle('Zveřejněno');
			m.setBody(`<p class="ok">✓ Hotovo, úpravy jsou odeslané.</p>
				<p>Na <a href="${esc(META.site)}" target="_blank" rel="noopener">www.taborslapanice.cz</a> se objeví obvykle do 1–2 minut.</p>
				<p class="hint">Když je tam ještě neuvidíš, obnov stránku pomocí <kbd>⌘</kbd> + <kbd>⇧</kbd> + <kbd>R</kbd> – prohlížeč si rád pamatuje starou verzi.</p>`);
			m.setButtons([{ label: 'Super', value: 'ok', kind: 'primary' }]);
		} else {
			m.setTitle('Zveřejnění se nepovedlo');
			m.setBody(`<p>${esc(res.error)}</p>` + (res.detail ? `<details><summary>Podrobnosti</summary><pre>${esc(res.detail)}</pre></details>` : ''));
			m.setButtons([{ label: 'Zavřít', value: 'ok', kind: 'primary' }]);
		}
		await m.done;
		await refreshPending();
		return !!res.ok;
	}

	async function discardFlow(pend) {
		const list = pend.items.map(i => `<li>${esc(i.label)}</li>`).join('');
		const r = await openModal({
			title: 'Zahodit uložené úpravy?',
			html: `<p class="warn">Tyhle stránky se vrátí do podoby, jakou mají teď na webu. <b>Uložené úpravy se nenávratně smažou.</b></p><ul>${list}</ul>`,
			buttons: [{ label: 'Nechat být', value: null }, { label: 'Ano, zahodit', value: 'yes', kind: 'danger' }]
		}).done;
		if (r.value !== 'yes') return;
		const res = await api('discard', { paths: pend.items.map(i => i.path) });
		if (!res.ok) { await message('Nepovedlo se', res.error, res.detail); return; }
		skipUnloadPrompt = true;
		try { sessionStorage.setItem('ed-toast', 'Úpravy zahozeny.'); } catch (err) { /* nevadí */ }
		location.reload();
	}

	async function discardUnsaved() {
		const r = await openModal({
			title: 'Zahodit neuložené změny?',
			html: '<p>Stránka se vrátí do stavu, jaký měla při posledním uložení.</p>',
			buttons: [{ label: 'Nechat být', value: null }, { label: 'Zahodit', value: 'yes', kind: 'danger' }]
		}).done;
		if (r.value !== 'yes') return;
		skipUnloadPrompt = true;
		location.reload();
	}

	async function quit() {
		if (changeCount()) {
			const r = await openModal({
				title: 'Máš neuložené změny',
				html: '<p>Na téhle stránce jsou změny, které ještě nejsou uložené.</p>',
				buttons: [
					{ label: 'Zpět', value: null },
					{ label: 'Ukončit bez uložení', value: 'quit', kind: 'danger' },
					{ label: 'Uložit a ukončit', value: 'save', kind: 'primary' }
				]
			}).done;
			if (!r.value) return;
			if (r.value === 'save' && !(await save({ noReload: true }))) return;
		}
		const pend = await refreshPending();
		if (pend.ok && (pend.items.length || pend.ahead)) {
			const r = await openModal({
				title: 'Úpravy ještě nejsou na webu',
				html: `<p>Máš uložené úpravy, které zatím nejsou zveřejněné (${pend.items.length || 1}). Návštěvníci je uvidí až po zveřejnění.</p>
					<p class="hint">Nevadí, když je teď nezveřejníš – zůstanou uložené v počítači a zveřejnit je půjde příště.</p>`,
				buttons: [
					{ label: 'Zpět', value: null },
					{ label: 'Jen ukončit', value: 'quit' },
					{ label: '🚀 Zveřejnit a ukončit', value: 'pub', kind: 'go' }
				]
			}).done;
			if (!r.value) return;
			if (r.value === 'pub' && !(await doPublish(pend))) return;
		}
		await api('quit', {});
		skipUnloadPrompt = true;
		leaves.forEach(r => { r.el.contentEditable = 'false'; });
		const bye = document.createElement('div');
		bye.className = 'bye';
		bye.innerHTML = '<div><h2>Editor je vypnutý ✓</h2><p>Tohle okno i černé okno Terminálu teď můžeš zavřít.</p>'
			+ '<p>Příště ho spustíš zase dvojklikem na <b>Upravit web</b>.</p></div>';
		ui.appendChild(bye);
		bar.hidden = true;
		tb.hidden = true;
	}

	function help() {
		openModal({
			title: 'Jak na úpravy',
			html: `<ul>
				<li><b>Text:</b> klikni na něj a piš – jako v PowerPointu. Nad textem se objeví panel na tučné písmo, barvy a odkazy.</li>
				<li><b>Řádky:</b> v panelu jsou tlačítka ⧉ Kopie, ＋ Nový a 🗑 na přidání nebo smazání odstavce či položky seznamu.</li>
				<li><b>Fotka:</b> najeď na ni myší a klikni na „Vyměnit fotku“. Velké fotky se samy zmenší.</li>
				<li><b>Uložit</b> (nebo <kbd>⌘</kbd> + <kbd>S</kbd>) zapíše změny do počítače. Žlutě orámované = ještě neuložené.</li>
				<li><b>Zveřejnit</b> pošle uložené úpravy na www.taborslapanice.cz – za 1–2 minuty je tam uvidí všichni.</li>
				<li><b>Jiná stránka:</b> vyber ji vlevo dole, nebo klikni na odkaz ve stránce.</li>
				<li><b>👁 Náhled</b> ukáže stránku přesně tak, jak ji uvidí návštěvníci.</li>
				<li><b>Šedě tečkované</b> věci upravit nejde – menu a patička jsou na všech stránkách stejné a odpočet vyplňuje web sám.</li>
				<li><b>Pokazil jsem to:</b> „Zahodit“ vrátí neuložené změny. Uložené, ale nezveřejněné úpravy jdou vrátit v okně Zveřejnit.</li>
			</ul>`,
			buttons: [{ label: 'Rozumím', value: 'ok', kind: 'primary' }]
		});
	}

	/* ------------------------------------------------------------------ *
	 *  Přechod mezi stránkami
	 * ------------------------------------------------------------------ */

	function hasUnsaved() { return changeCount() > 0; }

	function go(url) {
		if (hasUnsaved() && !confirm('Máš neuložené změny. Opravdu chceš odejít bez uložení?')) return;
		skipUnloadPrompt = true;
		location.href = url;
	}

	function followLink(a) {
		const href = a.getAttribute('href') || '';
		if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
		let url;
		try { url = new URL(href, location.href); } catch (err) { return; }
		if (url.origin !== location.origin) { window.open(url.href, '_blank', 'noopener'); return; }
		if (!/(\/|\.html)$/.test(url.pathname)) { window.open(url.href, '_blank', 'noopener'); return; }   // PDF, fotky…
		go(url.pathname + url.search);
	}

	api('pages').then(res => {
		if (!res.ok) return;
		const groups = {};
		res.pages.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
		pagesSel.innerHTML = Object.keys(groups).map(g => `<optgroup label="${esc(g)}">`
			+ groups[g].map(p => `<option value="${esc(p.url)}"${p.path === META.path ? ' selected' : ''}>${esc(p.title)}</option>`).join('')
			+ '</optgroup>').join('');
	});
	pagesSel.addEventListener('change', () => {
		const url = pagesSel.value;
		pagesSel.value = (pagesSel.querySelector('option[selected]') || {}).value || url;
		go(url);
	});

	/* ------------------------------------------------------------------ *
	 *  Události ve stránce
	 * ------------------------------------------------------------------ */

	document.addEventListener('input', e => {
		const el = editableOf(e.target);
		if (el) refreshDirty(el);
	});

	document.addEventListener('keydown', e => {
		if (modalOpen) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); return; }
		const el = editableOf(e.target);
		if (!el) return;
		if (e.key === 'Enter') {   // Enter = nový řádek uvnitř textu
			e.preventDefault();
			document.execCommand('insertLineBreak');
			refreshDirty(el);
		} else if (e.key === 'Escape') {
			el.blur();
		}
	}, true);

	// Chrome při přepsání CELÉHO textu odkazu odkaz smaže (číslo by přestalo být
	// klikací). Když výběr pokrývá přesně jeden celý odkaz, vyměníme jen jeho text.
	function linkCoveringSelection(host) {
		const sel = getSelection();
		if (!sel.rangeCount) return null;
		const range = sel.getRangeAt(0);
		if (range.collapsed) return null;
		const text = norm(range.toString());
		if (!text) return null;
		const hits = [...host.querySelectorAll('a')].filter(a => range.intersectsNode(a));
		return hits.length === 1 && norm(hits[0].textContent) === text ? hits[0] : null;
	}

	function replaceLinkText(a, text) {
		const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
		const nodes = [];
		while (walker.nextNode()) nodes.push(walker.currentNode);
		let target = nodes.find(t => t.data.trim()) || nodes[0];
		if (!target) {
			target = document.createTextNode('');
			a.appendChild(target);
		}
		nodes.forEach(t => { if (t !== target) t.data = ''; });
		target.data = text;
		const r = document.createRange();
		r.setStart(target, text.length);
		r.collapse(true);
		const s = getSelection();
		s.removeAllRanges();
		s.addRange(r);
	}

	document.addEventListener('beforeinput', e => {
		if (e.inputType !== 'insertText' && e.inputType !== 'insertReplacementText') return;
		const el = editableOf(e.target);
		if (!el) return;
		const a = linkCoveringSelection(el);
		if (!a) return;
		const text = e.data != null ? e.data : ((e.dataTransfer && e.dataTransfer.getData('text/plain')) || '');
		e.preventDefault();
		replaceLinkText(a, text);
		refreshDirty(el);
	}, true);

	document.addEventListener('paste', e => {   // vkládá se jen čistý text
		const el = editableOf(e.target);
		if (!el) return;
		e.preventDefault();
		const text = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/\r\n?/g, '\n');
		const a = linkCoveringSelection(el);
		if (a) {
			replaceLinkText(a, text.replace(/\s*\n\s*/g, ' ').trim());
		} else {
			text.split('\n').forEach((line, i) => {
				if (i) document.execCommand('insertLineBreak');
				if (line) document.execCommand('insertText', false, line);
			});
		}
		refreshDirty(el);
	}, true);

	document.addEventListener('dragstart', e => { if (!inUI(e)) e.preventDefault(); }, true);
	document.addEventListener('drop', e => { if (!inUI(e)) e.preventDefault(); }, true);
	document.addEventListener('submit', e => e.preventDefault(), true);

	document.addEventListener('click', e => {
		if (inUI(e)) return;
		const t = e.target;
		if (!t.closest) return;
		const a = t.closest('a[href]');
		const ed = editableOf(t);
		if (ed) {
			setActive(ed);
			if (a || t.closest('a')) e.preventDefault();
			return;
		}
		if (t.closest('[data-ed-img]')) { e.preventDefault(); return; }
		if (a) { e.preventDefault(); followLink(a); }
	}, true);

	document.addEventListener('focusin', e => {
		const el = editableOf(e.target);
		if (el) setActive(el);
	});
	// pojistka: aktivní je i text, ve kterém je kurzor (nespoléháme jen na focus)
	document.addEventListener('selectionchange', () => {
		if (modalOpen) return;
		const s = getSelection();
		if (!s.rangeCount) return;
		const el = editableOf(s.anchorNode);
		if (el && el !== active) setActive(el);
	});
	document.addEventListener('focusout', () => {
		setTimeout(() => {
			if (modalOpen) return;
			const ae = document.activeElement;
			if (ae === host) return;
			if (!editableOf(ae)) setActive(null);
		}, 120);
	});

	document.addEventListener('mouseover', e => {
		if (inUI(e)) return;
		const t = e.target;
		if (!t.closest) return;
		const img = t.closest('[data-ed-img]');
		if (img) { imgTarget = img; showImgBtn(img); } else imgBtn.hidden = true;
		const lock = t.closest('[data-ed-lock]');
		if (lock && LOCK_TEXT[lock.dataset.edLock]) {
			tip.textContent = '🔒 ' + LOCK_TEXT[lock.dataset.edLock];
			tip.hidden = false;
			const r = lock.getBoundingClientRect();
			const top = r.top - tip.offsetHeight - 8;
			tip.style.top = (top < 8 ? r.bottom + 8 : top) + 'px';
			tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8)) + 'px';
		} else tip.hidden = true;
	});

	const onMove = () => requestAnimationFrame(() => {
		positionToolbar();
		if (!imgBtn.hidden && imgTarget) showImgBtn(imgTarget);
		tip.hidden = true;
	});
	window.addEventListener('scroll', onMove, { passive: true });
	window.addEventListener('resize', onMove);

	window.addEventListener('beforeunload', e => {
		if (!skipUnloadPrompt && hasUnsaved()) {
			e.preventDefault();
			e.returnValue = '';
		}
	});

	/* ------------------------------------------------------------------ *
	 *  Tlačítka dolní lišty
	 * ------------------------------------------------------------------ */

	saveBtn.addEventListener('click', () => save());
	discardBtn.addEventListener('click', discardUnsaved);
	publishBtn.addEventListener('click', publishFlow);
	$('.b-preview').addEventListener('click', () => window.open(location.pathname + '?nahled=1', '_blank'));
	$('.b-help').addEventListener('click', help);
	$('.b-quit').addEventListener('click', quit);

	/* ------------------------------------------------------------------ *
	 *  Start
	 * ------------------------------------------------------------------ */

	updateStatus();
	refreshPending();
	try {
		const sk = 'ed-scroll:' + META.path;
		const sy = sessionStorage.getItem(sk);
		if (sy !== null) { sessionStorage.removeItem(sk); requestAnimationFrame(() => window.scrollTo(0, +sy)); }
		const st = sessionStorage.getItem('ed-toast');
		if (st) { sessionStorage.removeItem('ed-toast'); toast(st); }
		const resume = sessionStorage.getItem('ed-resume');
		if (resume) { sessionStorage.removeItem('ed-resume'); if (resume === 'publish') setTimeout(publishFlow, 300); }
	} catch (err) { /* sessionStorage nemusí být dostupné */ }

	// pro ladění
	window.__ED = { META, leaves, boxes, images, save, replaceImage, buildPayload, changeCount };
})();
