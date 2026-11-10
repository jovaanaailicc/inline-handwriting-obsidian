'use strict';
/*
 * Inline Handwriting — write by hand directly inside Obsidian notes (Live Preview).
 *
 * Storage (all inside the note):
 *   - Writing blocks:  ```handwriting\n{json}\n```   (take up real space between lines)
 *   - Margin notes:    " %%hw {json}%%" at the end of a text line (hidden, drawn on top,
 *                      move together with that line)
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, setIcon, Menu } = obsidian;
const { ViewPlugin, Decoration, EditorView } = require('@codemirror/view');
const { RangeSetBuilder, Transaction } = require('@codemirror/state');
let cmCommands = null;
try { cmCommands = require('@codemirror/commands'); } catch (e) { /* optional */ }

const SVGNS = 'http://www.w3.org/2000/svg';
const BLOCK_LANG = 'handwriting';
const NOTE_RE = / ?%%hw (\{[^%\n]*\})%%/g;
const BLOCK_RE = /^```handwriting[^\n]*\n([^\n]*)\n```[ \t]*$/gm;
const COMMIT_DELAY = 700;      // ms of pen inactivity before strokes are saved
const MIN_BLOCK_H = 60;
const BLOCK_PAD = 24;

const DEFAULT_SETTINGS = {
	penAlwaysDraws: true,
	showToolbar: true,
	inkMode: false,
	tool: 'pen',
	color: '#2f9bff',
	size: 2.5,
	colors: ['fg', '#2f9bff', '#ff5c5c', '#3ccf6b', '#ffd23f'],
	sizes: [1.5, 2.5, 4.5],
};

/* ------------------------------------------------------------------ */
/* Pure helpers (no Obsidian / DOM dependencies)                       */
/* ------------------------------------------------------------------ */

function uid() {
	return Math.random().toString(36).slice(2, 8);
}

function findItems(text) {
	const blocks = [];
	const notes = [];
	let m;
	BLOCK_RE.lastIndex = 0;
	while ((m = BLOCK_RE.exec(text))) {
		let data = null;
		try { data = JSON.parse(m[1]); } catch (e) { /* ignore broken */ }
		if (data && data.id) blocks.push({ id: data.id, from: m.index, to: m.index + m[0].length, data });
	}
	NOTE_RE.lastIndex = 0;
	while ((m = NOTE_RE.exec(text))) {
		let data = null;
		try { data = JSON.parse(m[1]); } catch (e) { /* ignore */ }
		if (data && data.id) notes.push({ id: data.id, from: m.index, to: m.index + m[0].length, data });
	}
	return { blocks, notes };
}

function blockText(data) {
	return '```' + BLOCK_LANG + '\n' + JSON.stringify(data) + '\n```';
}

function noteText(data) {
	return ' %%hw ' + JSON.stringify(data) + '%%';
}

/** Change that removes a whole block plus one adjacent newline, so no empty line is left. */
function blockDeleteRange(text, b) {
	let from = b.from, to = b.to;
	if (text.charCodeAt(to) === 10) to++;
	else if (from > 0 && text.charCodeAt(from - 1) === 10) from--;
	return { from, to, insert: '' };
}

/** Block overlapping the line [lineFrom, lineTo], else one ending just above or starting just below it. */
function blockNearLine(blocks, lineFrom, lineTo) {
	return blocks.find((b) => b.from <= lineTo && b.to >= lineFrom)
		|| blocks.find((b) => b.to === lineFrom - 1 || b.from === lineTo + 1)
		|| null;
}

/** EditorView that contains el. findFromDOM needs the editor's root element, not a descendant. */
function editorViewFor(el) {
	const root = el && el.closest ? el.closest('.cm-editor') : null;
	if (!root) return null;
	try { return EditorView.findFromDOM(root); } catch (e) { return null; }
}

/** Convert live strokes (doc-space) to stored strokes relative to an origin. */
function encodeStrokes(strokes, ox, oy) {
	return strokes.map((s) => {
		const p = [];
		for (const [x, y, pr] of s.pts) {
			p.push(Math.round((x - ox) * 2) / 2, Math.round((y - oy) * 2) / 2, Math.round(pr * 100));
		}
		return { c: s.c, w: s.w, t: s.t, p };
	});
}

/** Stored stroke -> array of [x, y, pressure(0..1)] */
function decodePoints(s) {
	const out = [];
	const p = s.p || [];
	for (let i = 0; i + 2 < p.length; i += 3) out.push([p[i], p[i + 1], p[i + 2] / 100]);
	return out;
}

function strokesMaxY(strokes) {
	let m = 0;
	for (const s of strokes) {
		const pts = decodePoints(s);
		for (const q of pts) m = Math.max(m, q[1] + s.w * 2);
	}
	return m;
}

function strokesMinY(strokes) {
	let m = Infinity;
	for (const s of strokes) for (const q of s.pts) m = Math.min(m, q[1] - s.w * 2);
	return m;
}

/** Variable-width outline for a pen stroke, as an SVG path. */
function penOutline(pts, size) {
	if (!pts.length) return '';
	const r = (i) => (size * (0.35 + 0.65 * Math.min(1, Math.max(0, pts[i][2])))) / 2 + 0.3;
	const n = pts.length;
	let allSame = true;
	for (let i = 1; i < n; i++) if (pts[i][0] !== pts[0][0] || pts[i][1] !== pts[0][1]) { allSame = false; break; }
	if (n === 1 || allSame) {
		const [x, y] = pts[0];
		const w = r(0);
		return `M${f(x - w)} ${f(y)}a${f(w)} ${f(w)} 0 1 0 ${f(2 * w)} 0a${f(w)} ${f(w)} 0 1 0 ${f(-2 * w)} 0Z`;
	}
	const left = [];
	const right = [];
	let lastNx = 0, lastNy = 1;
	for (let i = 0; i < n; i++) {
		const a = pts[Math.max(0, i - 1)];
		const b = pts[Math.min(n - 1, i + 1)];
		let dx = b[0] - a[0], dy = b[1] - a[1];
		const len = Math.hypot(dx, dy);
		let nx, ny;
		if (len < 1e-6) { nx = lastNx; ny = lastNy; } else { nx = -dy / len; ny = dx / len; lastNx = nx; lastNy = ny; }
		const w = r(i);
		left.push([pts[i][0] + nx * w, pts[i][1] + ny * w]);
		right.push([pts[i][0] - nx * w, pts[i][1] - ny * w]);
	}
	const we = r(n - 1), ws = r(0);
	let d = `M${f(left[0][0])} ${f(left[0][1])}`;
	for (let i = 1; i < n; i++) d += `L${f(left[i][0])} ${f(left[i][1])}`;
	d += `A${f(we)} ${f(we)} 0 0 0 ${f(right[n - 1][0])} ${f(right[n - 1][1])}`;
	for (let i = n - 2; i >= 0; i--) d += `L${f(right[i][0])} ${f(right[i][1])}`;
	d += `A${f(ws)} ${f(ws)} 0 0 0 ${f(left[0][0])} ${f(left[0][1])}Z`;
	return d;
}

function polyline(pts) {
	if (!pts.length) return '';
	let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
	if (pts.length === 1) return d + `L${f(pts[0][0] + 0.1)} ${f(pts[0][1])}`;
	for (let i = 1; i < pts.length; i++) d += `L${f(pts[i][0])} ${f(pts[i][1])}`;
	return d;
}

function f(n) { return Math.round(n * 10) / 10; }

function distToSegment(px, py, ax, ay, bx, by) {
	const dx = bx - ax, dy = by - ay;
	const l2 = dx * dx + dy * dy;
	let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeHit(pts, w, px, py, radius) {
	const lim = radius + w;
	if (pts.length === 1) return Math.hypot(px - pts[0][0], py - pts[0][1]) <= lim;
	for (let i = 1; i < pts.length; i++) {
		if (distToSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= lim) return true;
	}
	return false;
}

/** Which lines are inside fenced code or frontmatter (1-based line numbers). */
function codeLineSet(lines) {
	const set = new Set();
	let inFence = false, fenceCh = '';
	let i = 0;
	if (lines[0] !== undefined && lines[0].trim() === '---') {
		set.add(1);
		for (i = 1; i < lines.length; i++) {
			set.add(i + 1);
			if (lines[i].trim() === '---') { i++; break; }
		}
	}
	for (; i < lines.length; i++) {
		const t = lines[i];
		const m = /^\s*(```|~~~)/.exec(t);
		if (m) {
			if (!inFence) { inFence = true; fenceCh = m[1]; set.add(i + 1); continue; }
			if (m[1] === fenceCh) { inFence = false; set.add(i + 1); continue; }
		}
		if (inFence) set.add(i + 1);
	}
	return set;
}

/** Can a margin note be attached to the end of this line? */
function lineAcceptsNote(text) {
	if (!text.trim()) return false;
	if (/^#{1,6}\s/.test(text)) return false;              // headings (would pollute outline)
	if (/^\s*\|/.test(text)) return false;                 // tables
	if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) return false; // horizontal rules
	if (/^\s*(\$\$|```|~~~)/.test(text)) return false;
	return true;
}

/* ------------------------------------------------------------------ */
/* SVG rendering                                                       */
/* ------------------------------------------------------------------ */

function colorValue(c) {
	return c === 'fg' ? 'var(--text-normal)' : c;
}

function makePathEl(stroke, pts, hwid, idx) {
	const el = document.createElementNS(SVGNS, 'path');
	const color = colorValue(stroke.c);
	if (stroke.t === 'h') {
		el.setAttribute('d', polyline(pts));
		el.setAttribute('fill', 'none');
		el.style.stroke = color;
		el.setAttribute('stroke-width', String(stroke.w));
		el.setAttribute('stroke-linecap', 'round');
		el.setAttribute('stroke-linejoin', 'round');
		el.setAttribute('class', 'hw-hl');
	} else {
		el.setAttribute('d', penOutline(pts, stroke.w));
		el.style.fill = color;
	}
	if (hwid != null) {
		el.dataset.hwid = hwid;
		el.dataset.i = String(idx);
	}
	return el;
}

function updatePathEl(el, stroke, pts) {
	el.setAttribute('d', stroke.t === 'h' ? polyline(pts) : penOutline(pts, stroke.w));
}

/* ------------------------------------------------------------------ */
/* Editor extension                                                    */
/* ------------------------------------------------------------------ */

function buildNoteDecorations(view) {
	const b = new RangeSetBuilder();
	const hide = Decoration.replace({});
	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		NOTE_RE.lastIndex = 0;
		let m;
		while ((m = NOTE_RE.exec(text))) b.add(from + m.index, from + m.index + m[0].length, hide);
	}
	return b.finish();
}

function makeEditorExtension(plugin) {
	class InkView {
		constructor(view) {
			this.view = view;
			this.plugin = plugin;
			this.decorations = buildNoteDecorations(view);
			this.pending = null;     // { target, strokes: [], bbox }
			this.current = null;     // stroke being drawn
			this.erasing = null;
			this.activePointer = null;
			this.swallowMouse = false;
			this.commitTimer = null;
			this.noteBoxes = new Map();
			this.fading = [];

			const sd = view.scrollDOM;
			if (getComputedStyle(sd).position === 'static') sd.style.position = 'relative';

			this.overlay = document.createElementNS(SVGNS, 'svg');
			this.overlay.setAttribute('class', 'hw-overlay');
			this.notesG = document.createElementNS(SVGNS, 'g');
			this.pendingG = document.createElementNS(SVGNS, 'g');
			this.overlay.append(this.notesG, this.pendingG);
			sd.appendChild(this.overlay);

			this.onDown = this.onDown.bind(this);
			this.onMove = this.onMove.bind(this);
			this.onUp = this.onUp.bind(this);
			this.onMouse = this.onMouse.bind(this);
			sd.addEventListener('pointerdown', this.onDown, true);
			sd.addEventListener('pointermove', this.onMove, true);
			sd.addEventListener('pointerup', this.onUp, true);
			sd.addEventListener('pointercancel', this.onUp, true);
			for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
				sd.addEventListener(t, this.onMouse, true);
			}
			this.onContext = this.onContext.bind(this);
			sd.addEventListener('contextmenu', this.onContext, true);

			this.toolbar = plugin.createToolbar(view);
			view.dom.appendChild(this.toolbar.el);
			plugin.toolbars.add(this.toolbar);
			this.toolbar.refresh();

			this.scheduleRender();
		}

		update(u) {
			if (u.docChanged || u.viewportChanged) this.decorations = buildNoteDecorations(u.view);
			if (u.docChanged && this.pending && this.pending.target.pos != null) {
				this.pending.target.pos = u.changes.mapPos(this.pending.target.pos, 1);
			}
			if (u.docChanged || u.geometryChanged || u.viewportChanged || u.heightChanged) this.scheduleRender();
			this.toolbar.refresh();
		}

		destroy() {
			this.commitPending();
			const sd = this.view.scrollDOM;
			sd.removeEventListener('pointerdown', this.onDown, true);
			sd.removeEventListener('pointermove', this.onMove, true);
			sd.removeEventListener('pointerup', this.onUp, true);
			sd.removeEventListener('pointercancel', this.onUp, true);
			for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
				sd.removeEventListener(t, this.onMouse, true);
			}
			sd.removeEventListener('contextmenu', this.onContext, true);
			this.overlay.remove();
			this.toolbar.el.remove();
			this.plugin.toolbars.delete(this.toolbar);
		}

		/* ---------- environment ---------- */

		isLivePreview() {
			try {
				if (obsidian.editorLivePreviewField) return this.view.state.field(obsidian.editorLivePreviewField);
			} catch (e) { /* field missing */ }
			return true;
		}

		shouldDraw(e) {
			if (!this.isLivePreview()) return false;
			if (e.pointerType === 'touch') return false;
			const t = e.target;
			if (t && t.closest && t.closest('.hw-toolbar, .hw-block-delete, .cm-gutters, .edit-block-button, .copy-code-button')) return false;
			const s = this.plugin.settings;
			if (s.inkMode) return e.button === 0 || e.button === 5 || e.pointerType === 'pen';
			if (e.pointerType === 'pen' && s.penAlwaysDraws) return true;
			return false;
		}

		isEraser(e) {
			if (this.plugin.settings.tool === 'eraser') return true;
			return e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5);
		}

		docPoint(e) {
			const cr = this.view.contentDOM.getBoundingClientRect();
			let p = 0.5;
			if (e.pointerType === 'pen' && e.pressure > 0) p = e.pressure;
			return [e.clientX - cr.left, e.clientY - this.view.documentTop, p];
		}

		placeOverlay() {
			const sd = this.view.scrollDOM;
			const sr = sd.getBoundingClientRect();
			const cr = this.view.contentDOM.getBoundingClientRect();
			this.overlay.style.left = (cr.left - sr.left + sd.scrollLeft) + 'px';
			this.overlay.style.top = (this.view.documentTop - sr.top + sd.scrollTop) + 'px';
		}

		/* ---------- pointer handling ---------- */

		onMouse(e) {
			if (this.swallowMouse) {
				e.preventDefault();
				e.stopPropagation();
				if (e.type === 'click' || e.type === 'contextmenu') this.swallowMouse = false;
			}
		}

		onDown(e) {
			if (this.activePointer !== null || !this.shouldDraw(e)) return;
			e.preventDefault();
			e.stopPropagation();
			this.swallowMouse = true;
			this.activePointer = e.pointerId;
			try { this.view.scrollDOM.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
			this.placeOverlay();
			const pt = this.docPoint(e);

			if (this.isEraser(e)) {
				this.commitPending();
				this.erasing = { hits: new Map(), cands: this.collectStrokes() };
				this.eraseAt(pt);
				return;
			}

			const s = this.plugin.settings;
			const kind = s.tool === 'highlighter' ? 'h' : 'p';
			if (this.pending && !this.nearPending(pt)) this.commitPending();
			if (!this.pending) {
				this.pending = { target: this.resolveTarget(pt, e, kind), strokes: [], bbox: null };
			}
			clearTimeout(this.commitTimer);
			this.current = {
				c: s.color,
				w: kind === 'h' ? s.size * 5 + 6 : s.size,
				t: kind,
				pts: [pt],
			};
			this.current.el = makePathEl(this.current, this.current.pts, null, 0);
			this.pendingG.appendChild(this.current.el);
		}

		onMove(e) {
			if (e.pointerId !== this.activePointer) return;
			e.preventDefault();
			e.stopPropagation();
			const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
			const list = evs.length ? evs : [e];
			if (this.erasing) {
				for (const ev of list) this.eraseAt(this.docPoint(ev));
				return;
			}
			if (!this.current) return;
			const pts = this.current.pts;
			for (const ev of list) {
				const p = this.docPoint(ev);
				const last = pts[pts.length - 1];
				if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1) continue;
				pts.push(p);
			}
			updatePathEl(this.current.el, this.current, pts);
		}

		onUp(e) {
			if (e.pointerId !== this.activePointer) return;
			e.preventDefault();
			e.stopPropagation();
			this.activePointer = null;
			try { this.view.scrollDOM.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
			setTimeout(() => { this.swallowMouse = false; }, 400);

			if (this.erasing) {
				this.finishErase();
				return;
			}
			if (this.current && this.pending) {
				const st = this.current;
				this.current = null;
				this.pending.strokes.push(st);
				const bb = this.pending.bbox || { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
				for (const [x, y] of st.pts) {
					bb.x1 = Math.min(bb.x1, x); bb.y1 = Math.min(bb.y1, y);
					bb.x2 = Math.max(bb.x2, x); bb.y2 = Math.max(bb.y2, y);
				}
				this.pending.bbox = bb;
				clearTimeout(this.commitTimer);
				this.commitTimer = setTimeout(() => this.commitPending(), COMMIT_DELAY);
			}
		}

		nearPending(pt) {
			const bb = this.pending && this.pending.bbox;
			if (!bb) return true;
			return pt[0] > bb.x1 - 220 && pt[0] < bb.x2 + 220 && pt[1] > bb.y1 - 90 && pt[1] < bb.y2 + 90;
		}

		/* ---------- deciding where ink goes ---------- */

		resolveTarget(pt, e, kind) {
			const view = this.view;
			const doc = view.state.doc;

			const hit = document.elementFromPoint(e.clientX, e.clientY);
			const blockEl = hit && hit.closest ? hit.closest('.hw-block') : null;
			if (blockEl && view.dom.contains(blockEl) && blockEl.dataset.hwid) {
				return { kind: 'block', id: blockEl.dataset.hwid };
			}

			for (const [id, bb] of this.noteBoxes) {
				if (pt[0] > bb.x1 - 40 && pt[0] < bb.x2 + 40 && pt[1] > bb.y1 - 30 && pt[1] < bb.y2 + 30) {
					return { kind: 'note', id };
				}
			}

			const lastBlock = view.lineBlockAt(doc.length);
			if (pt[1] > lastBlock.bottom) {
				if (kind === 'h') return this.noteTargetNear(doc.lines);
				return { kind: 'newblock', mode: 'end', pos: doc.length };
			}

			const lb = view.lineBlockAtHeight(pt[1]);
			const line = doc.lineAt(lb.from);
			const codeLines = codeLineSet(doc.toString().split('\n'));

			if (kind === 'p' && !line.text.trim() && !codeLines.has(line.number)) {
				return { kind: 'newblock', mode: 'replace', pos: line.from };
			}
			const t = this.noteTargetNear(line.number, codeLines);
			if (t) return t;
			return { kind: 'newblock', mode: 'after', pos: line.to };
		}

		noteTargetNear(lineNo, codeLines) {
			const doc = this.view.state.doc;
			codeLines = codeLines || codeLineSet(doc.toString().split('\n'));
			const ok = (n) => n >= 1 && n <= doc.lines && !codeLines.has(n) && lineAcceptsNote(doc.line(n).text);
			const order = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6];
			for (const d of order) {
				const n = lineNo + d;
				if (ok(n)) return { kind: 'newnote', pos: doc.line(n).to };
			}
			return null;
		}

		/* ---------- saving ---------- */

		dispatchInk(changes) {
			const annotations = [Transaction.userEvent.of('input.handwriting')];
			if (cmCommands && cmCommands.isolateHistory) annotations.push(cmCommands.isolateHistory.of('full'));
			this.view.dispatch({ changes, annotations });
		}

		commitPending() {
			clearTimeout(this.commitTimer);
			const pending = this.pending;
			this.pending = null;
			if (!pending) return;
			if (this.current) {
				// a stroke is still in progress; keep the session alive
				this.pending = pending;
				return;
			}
			const pathEls = pending.strokes.map((s) => s.el);
			this.fadeOut(pathEls);
			if (!pending.strokes.length) return;

			const view = this.view;
			const doc = view.state.doc;
			const text = doc.toString();
			const items = findItems(text);
			const t = pending.target;
			const contentLeft = view.contentDOM.getBoundingClientRect().left;

			if (t.kind === 'block') {
				const b = items.blocks.find((x) => x.id === t.id);
				if (b) {
					const el = view.dom.querySelector(`.hw-block[data-hwid="${t.id}"]`);
					let ox = 0, oy;
					if (el) {
						const r = el.getBoundingClientRect();
						ox = r.left - contentLeft;
						oy = r.top - view.documentTop;
					} else {
						oy = view.lineBlockAt(b.from).top;
					}
					const data = b.data;
					data.s = (data.s || []).concat(encodeStrokes(pending.strokes, ox, oy));
					data.h = Math.max(data.h || MIN_BLOCK_H, Math.ceil(strokesMaxY(data.s) + BLOCK_PAD));
					this.dispatchInk({ from: b.from, to: b.to, insert: blockText(data) });
					return;
				}
				// block vanished: fall through and create a new one at the end
				t.kind = 'newblock'; t.mode = 'end'; t.pos = doc.length;
			}

			if (t.kind === 'note') {
				const n = items.notes.find((x) => x.id === t.id);
				if (n) {
					const oy = view.lineBlockAt(n.from).top;
					n.data.s = (n.data.s || []).concat(encodeStrokes(pending.strokes, 0, oy));
					this.dispatchInk({ from: n.from, to: n.to, insert: noteText(n.data) });
					return;
				}
				const near = this.noteTargetNear(doc.lineAt(view.lineBlockAtHeight(pending.bbox.y1).from).number);
				if (!near) return;
				Object.assign(t, near);
			}

			if (t.kind === 'newnote') {
				const pos = Math.min(t.pos, doc.length);
				const line = doc.lineAt(pos);
				const oy = view.lineBlockAt(line.from).top;
				const existing = items.notes.find((x) => x.from >= line.from && x.to <= line.to);
				if (existing) {
					const eoy = view.lineBlockAt(existing.from).top;
					existing.data.s = (existing.data.s || []).concat(encodeStrokes(pending.strokes, 0, eoy));
					this.dispatchInk({ from: existing.from, to: existing.to, insert: noteText(existing.data) });
				} else {
					const data = { id: uid(), s: encodeStrokes(pending.strokes, 0, oy) };
					this.dispatchInk({ from: line.to, to: line.to, insert: noteText(data) });
				}
				return;
			}

			if (t.kind === 'newblock') {
				let pos = Math.min(t.pos, doc.length);
				let mode = t.mode;
				let oy;
				if (mode === 'replace') {
					const line = doc.lineAt(pos);
					if (line.text.trim()) { mode = 'after'; pos = line.to; }
				}
				if (mode === 'end') oy = view.lineBlockAt(doc.length).bottom + 4;
				else if (mode === 'after') oy = view.lineBlockAt(pos).bottom;
				else oy = view.lineBlockAt(pos).top;

				// writing that starts above the block's top edge is shifted down into it
				const minY = strokesMinY(pending.strokes);
				if (minY < oy + 6) oy = minY - 6;
				const s = encodeStrokes(pending.strokes, 0, oy);
				const data = { id: uid(), h: Math.max(MIN_BLOCK_H, Math.ceil(strokesMaxY(s) + BLOCK_PAD)), s };

				if (mode === 'replace') {
					const line = doc.lineAt(pos);
					this.dispatchInk({ from: line.from, to: line.to, insert: blockText(data) });
				} else if (mode === 'end') {
					const prefix = text.endsWith('\n') || text.length === 0 ? '' : '\n';
					this.dispatchInk({ from: doc.length, to: doc.length, insert: prefix + blockText(data) + '\n' });
				} else {
					this.dispatchInk({ from: pos, to: pos, insert: '\n' + blockText(data) });
				}
			}
		}

		/* ---------- deleting whole blocks / notes ---------- */

		deleteBlock(id) {
			this.commitPending();
			const text = this.view.state.doc.toString();
			const b = findItems(text).blocks.find((x) => x.id === id);
			if (!b) return false;
			this.dispatchInk(blockDeleteRange(text, b));
			return true;
		}

		deleteNote(id) {
			this.commitPending();
			const n = findItems(this.view.state.doc.toString()).notes.find((x) => x.id === id);
			if (!n) return false;
			this.dispatchInk({ from: n.from, to: n.to, insert: '' });
			return true;
		}

		blockAtCursor() {
			const st = this.view.state;
			const line = st.doc.lineAt(st.selection.main.head);
			return blockNearLine(findItems(st.doc.toString()).blocks, line.from, line.to);
		}

		/** Margin note whose strokes are under the event, or null. The overlay ignores pointers, so hit-test by hand. */
		noteAtEvent(e) {
			const pt = this.docPoint(e);
			const pad = 8;
			const cands = [];
			for (const [id, bb] of this.noteBoxes) {
				if (pt[0] > bb.x1 - pad && pt[0] < bb.x2 + pad && pt[1] > bb.y1 - pad && pt[1] < bb.y2 + pad) cands.push(id);
			}
			if (!cands.length) return null;
			const notes = findItems(this.view.state.doc.toString()).notes;
			for (const id of cands) {
				const n = notes.find((x) => x.id === id);
				if (!n) continue;
				const oy = this.view.lineBlockAt(n.from).top;
				for (const s of n.data.s || []) {
					const pts = decodePoints(s).map(([x, y]) => [x, y + oy]);
					if (strokeHit(pts, s.w / 2, pt[0], pt[1], 6)) return id;
				}
			}
			return null;
		}

		onContext(e) {
			if (e.defaultPrevented || !this.isLivePreview()) return;
			const t = e.target;
			if (t && t.closest && t.closest('.hw-block, .hw-toolbar')) return;
			const id = this.noteAtEvent(e);
			if (!id) return;
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			menu.addItem((item) => item.setTitle('Delete margin note').setIcon('trash-2').onClick(() => this.deleteNote(id)));
			menu.showAtMouseEvent(e);
		}

		fadeOut(els) {
			// keep the live strokes visible until the saved version has rendered
			setTimeout(() => {
				for (const el of els) if (el) el.remove();
			}, 350);
		}

		/* ---------- eraser ---------- */

		collectStrokes() {
			const view = this.view;
			const items = findItems(view.state.doc.toString());
			const contentLeft = view.contentDOM.getBoundingClientRect().left;
			const out = [];
			for (const n of items.notes) {
				const oy = view.lineBlockAt(n.from).top;
				(n.data.s || []).forEach((s, i) => {
					out.push({ id: n.id, i, w: s.w, pts: decodePoints(s).map(([x, y]) => [x, y + oy]) });
				});
			}
			for (const b of items.blocks) {
				const el = view.dom.querySelector(`.hw-block[data-hwid="${b.id}"]`);
				if (!el) continue;
				const r = el.getBoundingClientRect();
				const ox = r.left - contentLeft, oy = r.top - view.documentTop;
				(b.data.s || []).forEach((s, i) => {
					out.push({ id: b.id, i, w: s.w, pts: decodePoints(s).map(([x, y]) => [x + ox, y + oy]) });
				});
			}
			return out;
		}

		eraseAt(pt) {
			const er = this.erasing;
			const radius = Math.max(6, this.plugin.settings.size * 3);
			for (const c of er.cands) {
				const key = c.id + ':' + c.i;
				if (er.hits.has(key)) continue;
				if (strokeHit(c.pts, c.w / 2, pt[0], pt[1], radius)) {
					er.hits.set(key, c);
					this.view.dom.querySelectorAll(`[data-hwid="${c.id}"][data-i="${c.i}"]`)
						.forEach((el) => { el.style.display = 'none'; });
				}
			}
		}

		finishErase() {
			const er = this.erasing;
			this.erasing = null;
			if (!er || !er.hits.size) return;
			const byId = new Map();
			for (const c of er.hits.values()) {
				if (!byId.has(c.id)) byId.set(c.id, new Set());
				byId.get(c.id).add(c.i);
			}
			const items = findItems(this.view.state.doc.toString());
			const changes = [];
			for (const [id, idxs] of byId) {
				const note = items.notes.find((x) => x.id === id);
				const block = items.blocks.find((x) => x.id === id);
				const it = note || block;
				if (!it) continue;
				it.data.s = (it.data.s || []).filter((_, i) => !idxs.has(i));
				if (note) {
					changes.push({ from: it.from, to: it.to, insert: it.data.s.length ? noteText(it.data) : '' });
				} else {
					changes.push({ from: it.from, to: it.to, insert: it.data.s.length ? blockText(it.data) : '' });
				}
			}
			changes.sort((a, b) => a.from - b.from);
			if (changes.length) this.dispatchInk(changes);
		}

		/* ---------- drawing margin notes ---------- */

		scheduleRender() {
			this.view.requestMeasure({
				key: this,
				read: (view) => {
					const items = findItems(view.state.doc.toString());
					return items.notes.map((n) => ({ n, oy: view.lineBlockAt(n.from).top }));
				},
				write: (notes) => {
					this.placeOverlay();
					this.notesG.replaceChildren();
					this.noteBoxes.clear();
					for (const { n, oy } of notes) {
						const g = document.createElementNS(SVGNS, 'g');
						g.setAttribute('transform', `translate(0 ${oy})`);
						const bb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
						(n.data.s || []).forEach((s, i) => {
							const pts = decodePoints(s);
							g.appendChild(makePathEl(s, pts, n.id, i));
							for (const [x, y] of pts) {
								bb.x1 = Math.min(bb.x1, x); bb.y1 = Math.min(bb.y1, y + oy);
								bb.x2 = Math.max(bb.x2, x); bb.y2 = Math.max(bb.y2, y + oy);
							}
						});
						this.notesG.appendChild(g);
						if (bb.x1 !== Infinity) this.noteBoxes.set(n.id, bb);
					}
				},
			});
		}
	}

	const vp = ViewPlugin.fromClass(InkView, { decorations: (v) => v.decorations });
	plugin.inkVP = vp;
	return [
		vp,
		EditorView.atomicRanges.of((view) => {
			const p = view.plugin(vp);
			return p ? p.decorations : Decoration.none;
		}),
	];
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class InlineHandwritingPlugin extends Plugin {
	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.toolbars = new Set();

		this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (src, el) => this.renderBlock(src, el));
		this.registerEditorExtension(makeEditorExtension(this));

		this.ribbon = this.addRibbonIcon('pen-tool', 'Toggle handwriting mode', () => this.toggleInkMode());
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('hw-status');

		this.addCommand({ id: 'toggle-ink-mode', name: 'Toggle handwriting mode (mouse draws)', callback: () => this.toggleInkMode() });
		this.addCommand({ id: 'tool-pen', name: 'Use pen', callback: () => this.setTool('pen') });
		this.addCommand({ id: 'tool-highlighter', name: 'Use highlighter', callback: () => this.setTool('highlighter') });
		this.addCommand({ id: 'tool-eraser', name: 'Use eraser', callback: () => this.setTool('eraser') });
		this.addCommand({
			id: 'insert-block',
			name: 'Insert empty handwriting space',
			editorCallback: (editor) => {
				const line = editor.getCursor().line;
				const text = editor.getLine(line);
				const block = blockText({ id: uid(), h: 200, s: [] });
				if (text.trim()) editor.replaceRange('\n' + block + '\n', { line, ch: text.length });
				else editor.replaceRange(block + '\n', { line, ch: 0 });
			},
		});
		this.addCommand({
			id: 'delete-block-at-cursor',
			name: 'Delete handwriting block at cursor',
			editorCheckCallback: (checking, editor, ctx) => {
				if (ctx && ctx.getMode && ctx.getMode() === 'preview') return false;
				const ink = editor && editor.cm ? this.inkFor(editor.cm) : null;
				const b = ink ? ink.blockAtCursor() : null;
				if (!b) return false;
				if (!checking) ink.deleteBlock(b.id);
				return true;
			},
		});

		this.addSettingTab(new HandwritingSettingTab(this.app, this));
		this.applyGlobalState();
	}

	onunload() {
		document.body.removeClass('hw-ink-mode');
	}

	async save() {
		await this.saveData(this.settings);
	}

	toggleInkMode() {
		this.settings.inkMode = !this.settings.inkMode;
		this.save();
		this.applyGlobalState();
	}

	setTool(tool) {
		this.settings.tool = tool;
		this.save();
		this.applyGlobalState();
	}

	applyGlobalState() {
		document.body.toggleClass('hw-ink-mode', !!this.settings.inkMode);
		document.body.toggleClass('hw-tool-eraser', this.settings.tool === 'eraser');
		if (this.statusEl) this.statusEl.setText(this.settings.inkMode ? '✎ Handwriting on' : '');
		if (this.ribbon) this.ribbon.toggleClass('is-active', !!this.settings.inkMode);
		for (const t of this.toolbars) t.refresh();
	}

	renderBlock(src, el) {
		let data;
		try { data = JSON.parse(src.trim()); } catch (e) {
			el.createDiv({ cls: 'hw-error', text: 'Handwriting block could not be read.' });
			return;
		}
		const box = el.createDiv({ cls: 'hw-block' });
		box.dataset.hwid = data.id || '';
		box.style.height = Math.max(MIN_BLOCK_H, data.h || MIN_BLOCK_H) + 'px';
		const svg = document.createElementNS(SVGNS, 'svg');
		svg.setAttribute('class', 'hw-block-svg');
		(data.s || []).forEach((s, i) => svg.appendChild(makePathEl(s, decodePoints(s), data.id, i)));
		box.appendChild(svg);

		// Delete button (shown on hover in Live Preview only; hidden by CSS elsewhere)
		const del = box.createEl('button', { cls: 'hw-block-delete clickable-icon', attr: { 'aria-label': 'Delete handwriting block' } });
		setIcon(del, 'trash-2');
		const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
		del.addEventListener('pointerdown', (e) => e.stopPropagation());
		del.addEventListener('mousedown', stop);
		del.addEventListener('mouseup', stop);
		del.addEventListener('click', (e) => {
			stop(e);
			const ink = this.inkForEl(del);
			if (ink && ink.isLivePreview()) ink.deleteBlock(data.id);
		});

		box.addEventListener('contextmenu', (e) => {
			if (box.closest('.markdown-embed')) return;
			const ink = this.inkForEl(box);
			if (!ink || !ink.isLivePreview()) return;
			stop(e);
			const menu = new Menu();
			menu.addItem((item) => item.setTitle('Delete handwriting block').setIcon('trash-2').onClick(() => ink.deleteBlock(data.id)));
			menu.showAtMouseEvent(e);
		});
	}

	/** InkView instance for an EditorView (null if the extension isn't running there). */
	inkFor(view) {
		try { return this.inkVP && view && view.plugin ? view.plugin(this.inkVP) : null; } catch (e) { return null; }
	}

	inkForEl(el) {
		return this.inkFor(editorViewFor(el));
	}

	createToolbar(view) {
		const plugin = this;
		const el = document.createElement('div');
		el.className = 'hw-toolbar';
		el.addEventListener('mousedown', (e) => e.preventDefault());
		el.addEventListener('pointerdown', (e) => e.stopPropagation());

		const btn = (icon, title, onClick) => {
			const b = document.createElement('button');
			b.className = 'hw-btn clickable-icon';
			b.setAttribute('aria-label', title);
			setIcon(b, icon);
			b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
			el.appendChild(b);
			return b;
		};
		const sep = () => { const s = document.createElement('span'); s.className = 'hw-sep'; el.appendChild(s); };

		const modeBtn = btn('pen-tool', 'Handwriting mode: mouse draws too', () => plugin.toggleInkMode());
		sep();
		const penBtn = btn('pencil', 'Pen', () => plugin.setTool('pen'));
		const hlBtn = btn('highlighter', 'Highlighter', () => plugin.setTool('highlighter'));
		const erBtn = btn('eraser', 'Eraser', () => plugin.setTool('eraser'));
		sep();
		const swatches = plugin.settings.colors.map((c) => {
			const b = document.createElement('button');
			b.className = 'hw-swatch';
			b.setAttribute('aria-label', c === 'fg' ? 'Text color' : c);
			b.style.setProperty('--hw-c', colorValue(c));
			b.addEventListener('click', (e) => {
				e.preventDefault();
				plugin.settings.color = c;
				if (plugin.settings.tool === 'eraser') plugin.settings.tool = 'pen';
				plugin.save();
				plugin.applyGlobalState();
			});
			el.appendChild(b);
			return { b, c };
		});
		sep();
		const sizeBtns = plugin.settings.sizes.map((sz, i) => {
			const b = document.createElement('button');
			b.className = 'hw-size';
			b.setAttribute('aria-label', ['Thin', 'Medium', 'Thick'][i] || 'Size');
			const dot = document.createElement('span');
			dot.style.width = dot.style.height = (3 + i * 3) + 'px';
			b.appendChild(dot);
			b.addEventListener('click', (e) => {
				e.preventDefault();
				plugin.settings.size = sz;
				plugin.save();
				plugin.applyGlobalState();
			});
			el.appendChild(b);
			return { b, sz };
		});
		sep();
		btn('undo-2', 'Undo', () => plugin.runHistory(view, 'undo'));
		btn('redo-2', 'Redo', () => plugin.runHistory(view, 'redo'));

		return {
			el,
			refresh() {
				const s = plugin.settings;
				el.style.display = s.showToolbar ? '' : 'none';
				modeBtn.toggleClass('is-active', !!s.inkMode);
				penBtn.toggleClass('is-active', s.tool === 'pen');
				hlBtn.toggleClass('is-active', s.tool === 'highlighter');
				erBtn.toggleClass('is-active', s.tool === 'eraser');
				for (const { b, c } of swatches) b.toggleClass('is-active', c === s.color);
				for (const { b, sz } of sizeBtns) b.toggleClass('is-active', sz === s.size);
			},
		};
	}

	runHistory(view, which) {
		if (cmCommands && cmCommands[which]) {
			cmCommands[which](view);
			return;
		}
		this.app.commands.executeCommandById(which === 'undo' ? 'editor:undo' : 'editor:redo');
	}
}

class HandwritingSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const p = this.plugin;

		new Setting(containerEl)
			.setName('Pen always draws')
			.setDesc('When a pen/tablet stylus touches a note it writes, while the mouse keeps editing text. Turn off if your pen should behave like a mouse.')
			.addToggle((t) => t.setValue(p.settings.penAlwaysDraws).onChange(async (v) => {
				p.settings.penAlwaysDraws = v; await p.save();
			}));

		new Setting(containerEl)
			.setName('Show toolbar')
			.setDesc('Floating toolbar in the bottom-right corner of each note.')
			.addToggle((t) => t.setValue(p.settings.showToolbar).onChange(async (v) => {
				p.settings.showToolbar = v; await p.save(); p.applyGlobalState();
			}));

		new Setting(containerEl)
			.setName('Pen colors')
			.setDesc('Comma-separated hex colors. Use "fg" for the theme text color. Reload the note to see changes.')
			.addText((t) => t.setValue(p.settings.colors.join(', ')).onChange(async (v) => {
				const list = v.split(',').map((x) => x.trim()).filter((x) => x === 'fg' || /^#[0-9a-fA-F]{3,8}$/.test(x));
				if (list.length) { p.settings.colors = list; await p.save(); }
			}));
	}
}

module.exports = InlineHandwritingPlugin;
module.exports.default = InlineHandwritingPlugin;
module.exports._internals = {
	findItems, blockText, noteText, encodeStrokes, decodePoints, penOutline, polyline,
	strokeHit, codeLineSet, lineAcceptsNote, strokesMaxY, blockDeleteRange, blockNearLine,
};
