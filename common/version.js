const REPO = 'babeltimeus-fu-rayjo/Collection';
const KEY = 'collection-version';
const TTL = 120_000;

async function init() {
  let info;
  try {
    const raw = localStorage.getItem(KEY);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && Date.now() - cached.ts < TTL) {
      info = cached;
    } else {
      const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      info = {
        hash: data.sha.slice(0, 7),
        date: data.commit.committer.date,
        ts: Date.now(),
      };
      try { localStorage.setItem(KEY, JSON.stringify(info)); } catch {}
    }
  } catch { return; }

  const d = new Date(info.date);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${info.hash} · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const el = document.createElement('div');
  el.id = 'ver';
  el.textContent = stamp;
  el.style.cssText =
    'position:fixed;right:12px;bottom:12px;font:10px/1 "SF Mono",Menlo,Consolas,monospace;' +
    'color:rgba(255,255,255,.3);z-index:1;pointer-events:none;user-select:none;';
  document.body.append(el);
}

init();
