// common/settings.js — a per-game testing & pacing settings drawer, shared by
// every game in the collection.
//
// Each app registers its tunables (mostly delays) with defaults that match
// the shipped behavior exactly; a floating ⚙ opens a drawer for tweaking
// them live — no reload needed, values are read at the moment they're used.
// Overrides persist per game, per browser (localStorage `<stem>-settings`):
// the HOST's browser governs host-side pacing (bot thinking, table stalls),
// every player's own browser governs their announcements, bubbles, overlays.
//
//   const cfg = initSettings('skk', DEFS);
//   cfg('overlayDelay')   → ms, scaled by the "All delays ×" multiplier
//   cfg.range('botPlay')  → base + random jitter, both scaled (def: [b, j])
//   cfg.raw('talkScale')  → unscaled value (multipliers, char counts)
//   cfg.on('autoNext')    → boolean
//
// Def fields: { key, label, def, section, min, max, step, unit, ms, bool,
// host, hint }. `def: [base, jitter]` renders a two-field "base + up to"
// row; `ms: false` exempts a number from the speed multiplier; `host: true`
// tags rows that only matter on the host's device.

const SPEED = {
  key: 'speed',
  label: 'All delays ×',
  def: 1,
  min: 0.05,
  max: 5,
  step: 0.05,
  unit: '×',
  ms: false,
  section: 'General',
  hint: 'One knob to rule them: multiplies every delay below.',
};

export function initSettings(stem, defs) {
  const all = [SPEED, ...defs];
  const byKey = new Map(all.map((d) => [d.key, d]));
  const KEY = `${stem}-settings`;
  let saved = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch {}

  const rawVal = (k) => {
    const d = byKey.get(k);
    if (!d) return 0;
    const v = saved[k];
    if (v === undefined || v === null) return d.def;
    if (Array.isArray(d.def)) return Array.isArray(v) && v.length === 2 ? v : d.def;
    if (d.bool) return !!v;
    return typeof v === 'number' && Number.isFinite(v) ? v : d.def;
  };
  const mult = () => {
    const m = rawVal('speed');
    return Number.isFinite(m) && m > 0 ? m : 1;
  };
  const scaleOf = (d) => (d && d.ms === false ? 1 : mult());

  const cfg = (k) => {
    const d = byKey.get(k);
    const v = rawVal(k);
    const n = Array.isArray(v) ? v[0] : Number(v) || 0;
    return Math.round(n * scaleOf(d));
  };
  cfg.range = (k) => {
    const d = byKey.get(k);
    const v = rawVal(k);
    const [b, j] = Array.isArray(v) ? v : [Number(v) || 0, 0];
    return Math.round((b + Math.random() * j) * scaleOf(d));
  };
  cfg.raw = rawVal;
  cfg.on = (k) => !!rawVal(k);

  // ------------------------------------------------------------- storage
  function persist() {
    try {
      if (Object.keys(saved).length) localStorage.setItem(KEY, JSON.stringify(saved));
      else localStorage.removeItem(KEY);
    } catch {}
  }
  function setVal(k, v) {
    const d = byKey.get(k);
    if (!d) return;
    if (JSON.stringify(v) === JSON.stringify(d.def)) delete saved[k];
    else saved[k] = v;
    persist();
  }
  const isMod = (k) => saved[k] !== undefined;

  // ------------------------------------------------------------------ ui
  const css = `
#cfg-gear { position: fixed; left: 12px; bottom: 12px; z-index: 95; width: 36px; height: 36px;
  border-radius: 50%; border: 1px solid rgba(255,255,255,.22); background: rgba(16,19,28,.82);
  color: #dfe6f2; font-size: 17px; line-height: 1; cursor: pointer; opacity: .5;
  transition: opacity .15s, transform .15s; padding: 0; }
#cfg-gear:hover { opacity: 1; transform: rotate(25deg); }
#cfg-gear.mod { opacity: .95; border-color: #e0b34e; color: #e0b34e; }
#cfg-drawer { position: fixed; left: 12px; bottom: 56px; z-index: 96; width: min(352px, calc(100vw - 24px));
  max-height: min(74vh, 640px); overflow-y: auto; overscroll-behavior: contain; border-radius: 14px;
  background: rgba(14,17,25,.97); border: 1px solid rgba(255,255,255,.16);
  box-shadow: 0 14px 44px rgba(0,0,0,.5); color: #dfe6f2; font-size: 13px;
  padding: 12px 14px 10px; backdrop-filter: blur(6px); }
#cfg-drawer.hidden { display: none; }
#cfg-drawer h3 { margin: 0 0 2px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
#cfg-drawer h3 .x { margin-left: auto; background: none; border: 0; color: #9aa7ba; font-size: 17px; cursor: pointer; padding: 2px 6px; }
#cfg-drawer .cfg-note { color: #8d99ad; font-size: 11px; margin: 0 0 8px; line-height: 1.35; }
#cfg-drawer .cfg-sec { margin: 10px 0 4px; font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: #93a3ff; opacity: .85; }
.cfg-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 8px; border-radius: 8px; border-left: 2px solid transparent; }
.cfg-row.mod { border-left-color: #e0b34e; background: rgba(224,179,78,.07); }
.cfg-row label { flex: 1 1 auto; min-width: 0; cursor: default; }
.cfg-row .cfg-host { font-size: 9.5px; color: #6ec1a6; border: 1px solid rgba(110,193,166,.5); border-radius: 4px; padding: 0 4px; margin-left: 5px; vertical-align: 1px; }
.cfg-row input[type="number"] { width: 66px; background: rgba(255,255,255,.07); color: #eef3fb;
  border: 1px solid rgba(255,255,255,.18); border-radius: 6px; padding: 3px 5px; font-size: 12.5px; }
.cfg-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: #e0b34e; }
.cfg-row .cfg-plus { color: #7f8ca0; font-size: 11px; }
.cfg-row .cfg-unit { color: #7f8ca0; font-size: 11px; width: 26px; }
.cfg-row .cfg-reset { background: none; border: 0; color: #e0b34e; cursor: pointer; font-size: 13px;
  padding: 0 2px; visibility: hidden; }
.cfg-row.mod .cfg-reset { visibility: visible; }
.cfg-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.1); }
.cfg-foot button { background: rgba(255,255,255,.08); color: #dfe6f2; border: 1px solid rgba(255,255,255,.18);
  border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.cfg-foot button:hover { background: rgba(255,255,255,.15); }
.cfg-foot .cfg-count { margin-left: auto; color: #8d99ad; font-size: 11px; }`;

  function ensureStyle() {
    if (document.getElementById('cfg-style')) return;
    const s = document.createElement('style');
    s.id = 'cfg-style';
    s.textContent = css;
    document.head.append(s);
  }

  let drawer = null;

  function numInput(d, get, set, idx) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = String(d.min ?? 0);
    inp.max = String(d.max ?? 60000);
    inp.step = String(d.step ?? (d.unit === '×' ? 0.05 : 50));
    inp.value = String(get());
    inp.addEventListener('change', () => {
      let n = parseFloat(inp.value);
      if (!Number.isFinite(n)) n = Array.isArray(d.def) ? d.def[idx] : d.def;
      n = Math.min(Number(inp.max), Math.max(Number(inp.min), n));
      inp.value = String(n);
      set(n);
    });
    return inp;
  }

  function row(d) {
    const r = document.createElement('div');
    r.className = 'cfg-row';
    const lab = document.createElement('label');
    lab.textContent = d.label;
    if (d.hint) lab.title = d.hint;
    if (d.host) {
      const tag = document.createElement('span');
      tag.className = 'cfg-host';
      tag.textContent = 'host';
      tag.title = 'Applies on the host’s device';
      lab.append(tag);
    }
    r.append(lab);
    const refresh = () => {
      r.classList.toggle('mod', isMod(d.key));
      gear.classList.toggle('mod', all.some((x) => isMod(x.key)));
    };
    const inputs = [];
    if (d.bool) {
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = !!rawVal(d.key);
      inp.addEventListener('change', () => {
        setVal(d.key, inp.checked);
        refresh();
      });
      inputs.push(inp);
      r.append(inp);
    } else if (Array.isArray(d.def)) {
      const cur = () => rawVal(d.key);
      const a = numInput(d, () => cur()[0], (n) => {
        setVal(d.key, [n, cur()[1]]);
        refresh();
      }, 0);
      const plus = document.createElement('span');
      plus.className = 'cfg-plus';
      plus.textContent = '+ up to';
      const b = numInput(d, () => cur()[1], (n) => {
        setVal(d.key, [cur()[0], n]);
        refresh();
      }, 1);
      inputs.push(a, b);
      r.append(a, plus, b);
    } else {
      const inp = numInput(d, () => rawVal(d.key), (n) => {
        setVal(d.key, n);
        refresh();
      }, 0);
      inputs.push(inp);
      r.append(inp);
    }
    const unit = document.createElement('span');
    unit.className = 'cfg-unit';
    unit.textContent = d.unit || (d.bool ? '' : 'ms');
    r.append(unit);
    const reset = document.createElement('button');
    reset.className = 'cfg-reset';
    reset.type = 'button';
    reset.title = 'Back to default';
    reset.textContent = '↺';
    reset.addEventListener('click', () => {
      setVal(d.key, d.def);
      if (d.bool) inputs[0].checked = !!d.def;
      else if (Array.isArray(d.def)) {
        inputs[0].value = String(d.def[0]);
        inputs[1].value = String(d.def[1]);
      } else inputs[0].value = String(d.def);
      refresh();
    });
    r.append(reset);
    refresh();
    return r;
  }

  function buildDrawer() {
    drawer = document.createElement('div');
    drawer.id = 'cfg-drawer';
    const h = document.createElement('h3');
    h.textContent = '⚙ Testing settings';
    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.textContent = '✕';
    x.addEventListener('click', () => drawer.classList.add('hidden'));
    h.append(x);
    drawer.append(h);
    const note = document.createElement('p');
    note.className = 'cfg-note';
    note.textContent = 'Saved in this browser only, applied live. Rows tagged “host” pace the whole table, from the host’s device.';
    drawer.append(note);
    let sec = null;
    for (const d of all) {
      if (d.section !== sec) {
        sec = d.section;
        const sh = document.createElement('div');
        sh.className = 'cfg-sec';
        sh.textContent = sec || 'Other';
        drawer.append(sh);
      }
      drawer.append(row(d));
    }
    const foot = document.createElement('div');
    foot.className = 'cfg-foot';
    const resetAll = document.createElement('button');
    resetAll.type = 'button';
    resetAll.textContent = 'Reset all';
    resetAll.addEventListener('click', () => {
      saved = {};
      persist();
      drawer.remove();
      drawer = null;
      openDrawer();
    });
    const count = document.createElement('span');
    count.className = 'cfg-count';
    count.textContent = `${stem} · ${all.length} knobs`;
    foot.append(resetAll, count);
    drawer.append(foot);
    document.body.append(drawer);
  }

  function openDrawer() {
    if (!drawer) buildDrawer();
    else drawer.classList.toggle('hidden');
  }

  ensureStyle();
  const gear = document.createElement('button');
  gear.id = 'cfg-gear';
  gear.type = 'button';
  gear.title = 'Testing & pacing settings';
  gear.textContent = '⚙';
  gear.classList.toggle('mod', all.some((x) => isMod(x.key)));
  gear.addEventListener('click', openDrawer);
  document.body.append(gear);

  return cfg;
}
