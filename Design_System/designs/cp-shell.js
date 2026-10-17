// cp-shell.js — Civil Portal shared shell: theme toggle + command palette.
// <cp-theme-toggle>      — light/dark switch; persists in localStorage('cp-theme'), syncs across screens.
// <cp-command-palette>   — Ctrl/⌘+K palette (web screens only). Place once per page.
// <cp-command-trigger>   — header button that opens the palette.
(function () {
  if (window.__cpShell) return; window.__cpShell = true;

  const DARK = {
    bg:'#14181B', surface:'#1D2328', surface2:'#242B30', ink:'#F2F4F5', ink2:'#A3ABB1', ink3:'#8A949B',
    line:'#2E363C', line2:'#3C454B', accent:'#3FA7AE', accentH:'#5FC4CA', accentTint:'#123239',
    ok:'#5FBE8C', okT:'#16302A', warn:'#E0A63C', warnT:'#332811', bad:'#F08076', badT:'#3A1F1C', info:'#7FB0DE', infoT:'#16283A'
  };
  const vars = Object.entries(DARK).map(([k, v]) => `--${k}:${v} !important;`).join('');
  const css = `
    html[data-cp-theme="dark"] body { background:#14181B !important; color-scheme:dark; }
    html[data-cp-theme="dark"] [style*="--surface"], html[data-cp-theme="dark"] cp-command-palette { ${vars} }
    html[data-cp-theme="dark"] [style*="background: var(--accent)"],
    html[data-cp-theme="dark"] [style*="background: var(--ok)"],
    html[data-cp-theme="dark"] [style*="background: var(--bad)"] { color:#0B1A1C !important; }
    html[data-cp-theme="dark"] [style*="background: var(--accent)"] svg,
    html[data-cp-theme="dark"] [style*="background: var(--ok)"] svg { stroke:currentColor; }
    /* heat-dark: light teal tints used in density maps */
    html[data-cp-theme="dark"] [style*="background: rgb(220, 233, 233)"] { background:#16353A !important; color:#BFE3E1 !important; }
    html[data-cp-theme="dark"] [style*="background: rgb(175, 208, 210)"] { background:#1E5258 !important; color:#E6F4F3 !important; }
    html[data-cp-theme="dark"] input, html[data-cp-theme="dark"] textarea, html[data-cp-theme="dark"] select { color-scheme:dark; }
    html[data-cp-theme="dark"] ::placeholder { color:#7B858C; }
  `;
  const st = document.createElement('style'); st.id = 'cp-shell-theme'; st.textContent = css;
  document.head.appendChild(st);

  const KEY = 'cp-theme';
  const get = () => { try { return localStorage.getItem(KEY) || 'light'; } catch (e) { return 'light'; } };
  const apply = t => { document.documentElement.setAttribute('data-cp-theme', t); document.dispatchEvent(new CustomEvent('cp-theme', { detail:t })); };
  const set = t => { try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); };
  apply(get());
  window.addEventListener('storage', e => { if (e.key === KEY) apply(e.newValue || 'light'); });
  window.cpTheme = { get, set, toggle: () => set(get() === 'dark' ? 'light' : 'dark') };

  const SUN = '<path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  const MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>';

  class ThemeToggle extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode:'open' });
      root.innerHTML = `<style>
        :host{display:inline-flex}
        button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 12px;border-radius:8px;cursor:pointer;
          font:500 13px/1 'IBM Plex Sans',system-ui,sans-serif;border:1px solid var(--line2,#C7CDD1);background:var(--surface,#fff);color:var(--ink,#14181B)}
        button:hover{background:var(--surface2,#EDEFF0)}
        button:focus-visible{outline:2px solid var(--accent,#0F5C63);outline-offset:2px}
        svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
        :host([compact]) span{display:none} :host([compact]) button{width:42px;justify-content:center;padding:0}
      </style><button type="button" aria-label="Toggle dark mode"><svg viewBox="0 0 24 24"></svg><span></span></button>`;
      this._btn = root.querySelector('button');
      this._btn.addEventListener('click', () => window.cpTheme.toggle());
      this._sync = () => {
        const d = get() === 'dark';
        root.querySelector('svg').innerHTML = d ? SUN : MOON;
        root.querySelector('span').textContent = d ? 'Light' : 'Dark';
        this._btn.setAttribute('aria-pressed', String(d));
        this._btn.title = d ? 'Switch to light mode' : 'Switch to dark mode';
      };
      document.addEventListener('cp-theme', this._sync); this._sync();
    }
    disconnectedCallback() { document.removeEventListener('cp-theme', this._sync); }
  }
  if (!customElements.get('cp-theme-toggle')) customElements.define('cp-theme-toggle', ThemeToggle);

  // ------------------------------------------------------------------ command palette
  const ITEMS = [
    { g:'Go to', t:'Area dashboard', s:'Nigahi · KPIs and scorecard', href:'Area Dashboard.dc.html', k:'dashboard home kpi' },
    { g:'Go to', t:'Work queue', s:'Assign, verify, flag', href:'JE Work Queue.dc.html', k:'queue je overseer incharge assign' },
    { g:'Go to', t:'Contractor scorecard', s:'Drill down from any number', href:'Contractor Scorecard.dc.html', k:'contractor shakti vindhya sai ram sla' },
    { g:'Go to', t:'All-Areas overview', s:'HQ · 13 Areas, heatmap, meeting mode', href:'HQ Overview.dc.html', k:'hq headquarters areas meeting' },
    { g:'Go to', t:'Administration', s:'Users, quarter master, SLA rules, translations, audit', href:'Admin Console.dc.html', k:'admin users roles translation audit sla quarter master' },
    { g:'Go to', t:'Monthly performance report', s:'Printable office note, Sep 2026', href:'Monthly Performance Report.dc.html', k:'report pdf print note deduction' },
    { g:'Go to', t:'Complaint slip', s:'Printable resident copy and job card', href:'Complaint Slip.dc.html', k:'slip print job card' },
    { g:'Complaints', t:'NGH/2609/0412', s:'Kitchen tap leaking · Qtr C-245 · 6 h left', href:'JE Work Queue.dc.html', k:'tap plumbing c-245 0412' },
    { g:'Complaints', t:'NGH/2609/0388', s:'Seepage on bedroom ceiling · Qtr B-12 · 1 day overdue', href:'JE Work Queue.dc.html', k:'seepage b-12 0388 overdue' },
    { g:'Complaints', t:'NGH/2609/0402', s:'Drain choked behind quarter · Qtr A-101 · returned for rework', href:'JE Work Queue.dc.html', k:'drain a-101 0402 rework' },
    { g:'Quarters', t:'Qtr No. C-245, Nigahi', s:'Type III · R. K. Verma · 4 complaints in 90 days', href:'Admin Console.dc.html', k:'c-245 verma quarter' },
    { g:'Quarters', t:'Qtr No. B-12, Nigahi', s:'Type II · A. Khan · repeat seepage', href:'Admin Console.dc.html', k:'b-12 khan quarter' },
    { g:'Actions', t:'Toggle dark mode', s:'Switch between light and dark', run:() => window.cpTheme.toggle(), k:'theme dark light night' },
    { g:'Actions', t:'Download monthly report', s:'Nigahi · September 2026 · PDF', href:'Monthly Performance Report.dc.html', k:'download export pdf' },
    { g:'Actions', t:'Add user', s:'Administration · Users and roles', href:'Admin Console.dc.html', k:'new user invite' }
  ];

  class Palette extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode:'open' });
      root.innerHTML = `<style>
        :host{position:fixed;inset:0;z-index:1000;display:none;font-family:'IBM Plex Sans','IBM Plex Sans Devanagari',system-ui,sans-serif}
        :host([open]){display:block}
        .scrim{position:absolute;inset:0;background:rgba(20,24,27,.5)}
        .box{position:absolute;left:50%;top:12vh;transform:translateX(-50%);width:min(640px,calc(100vw - 32px));max-height:70vh;display:flex;flex-direction:column;
          border-radius:14px;overflow:hidden;background:var(--surface,#fff);color:var(--ink,#14181B);box-shadow:0 16px 40px rgba(20,24,27,.3);border:1px solid var(--line,#DFE3E5);animation:in .16s ease-out}
        @keyframes in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}
        @media (prefers-reduced-motion:reduce){.box{animation:none}}
        .q{display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--line,#DFE3E5)}
        .q svg{width:18px;height:18px;fill:none;stroke:var(--ink3,#7B858C);stroke-width:1.9;stroke-linecap:round;flex:none}
        input{all:unset;flex:1;height:56px;font-size:16px;color:var(--ink,#14181B)}
        input::placeholder{color:var(--ink3,#7B858C)}
        kbd{font:500 11px/1 'IBM Plex Mono',monospace;padding:4px 6px;border-radius:4px;border:1px solid var(--line2,#C7CDD1);color:var(--ink2,#5A646B)}
        .list{overflow:auto;padding:6px}
        .g{padding:10px 12px 4px;font-size:12px;font-weight:600;color:var(--ink2,#5A646B)}
        .it{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;cursor:pointer}
        .it[aria-selected="true"]{background:var(--accentTint,#E2F0F0)}
        .t{font-size:14px;font-weight:500}
        .s{font-size:12px;color:var(--ink2,#5A646B);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .tx{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
        .mono{font-family:'IBM Plex Mono',monospace}
        .empty{padding:28px 16px;font-size:14px;color:var(--ink2,#5A646B)}
        .foot{display:flex;gap:16px;padding:10px 16px;border-top:1px solid var(--line,#DFE3E5);font-size:12px;color:var(--ink2,#5A646B)}
        .foot span{display:inline-flex;align-items:center;gap:6px}
      </style>
      <div class="scrim"></div>
      <div class="box" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="q"><svg viewBox="0 0 24 24"><path d="M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4"/></svg>
          <input placeholder="Go to a screen, find a complaint or quarter, or run an action" aria-label="Search"><kbd>Esc</kbd></div>
        <div class="list" role="listbox"></div>
        <div class="foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl</kbd><kbd>K</kbd> toggle</span></div>
      </div>`;
      this.$in = root.querySelector('input'); this.$list = root.querySelector('.list'); this.sel = 0;
      root.querySelector('.scrim').addEventListener('click', () => this.close());
      this.$in.addEventListener('input', () => { this.sel = 0; this.render(); });
      this.$in.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); this.pick(this.results[this.sel]); }
        else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      });
      this._key = e => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); this.hasAttribute('open') ? this.close() : this.open(); }
      };
      window.addEventListener('keydown', this._key);
      window.cpPalette = this;
    }
    disconnectedCallback() { window.removeEventListener('keydown', this._key); }
    open() { this._prev = document.activeElement; this.setAttribute('open', ''); this.$in.value = ''; this.sel = 0; this.render(); setTimeout(() => this.$in.focus(), 0); }
    close() { this.removeAttribute('open'); if (this._prev && this._prev.focus) this._prev.focus(); }
    move(d) { if (!this.results.length) return; this.sel = (this.sel + d + this.results.length) % this.results.length; this.render(true); }
    pick(it) { if (!it) return; this.close(); if (it.run) it.run(); else if (it.href) location.href = it.href; }
    render(keepScroll) {
      const q = this.$in.value.trim().toLowerCase();
      this.results = ITEMS.filter(i => !q || (i.t + ' ' + i.s + ' ' + i.k).toLowerCase().includes(q));
      if (!this.results.length) { this.$list.innerHTML = `<div class="empty">Nothing matches “${q.replace(/[<>&]/g, '')}”. Try a quarter number like C-245 or a complaint number like 0412.</div>`; return; }
      let html = '', last = '';
      this.results.forEach((it, i) => {
        if (it.g !== last) { html += `<div class="g">${it.g}</div>`; last = it.g; }
        html += `<div class="it" role="option" data-i="${i}" aria-selected="${i === this.sel}"><div class="tx"><span class="t ${it.g === 'Complaints' ? 'mono' : ''}">${it.t}</span><span class="s">${it.s}</span></div></div>`;
      });
      this.$list.innerHTML = html;
      this.$list.querySelectorAll('.it').forEach(el => {
        el.addEventListener('mousemove', () => { const i = +el.dataset.i; if (i !== this.sel) { this.sel = i; this.render(true); } });
        el.addEventListener('click', () => this.pick(this.results[+el.dataset.i]));
      });
      const cur = this.$list.querySelector('[aria-selected="true"]');
      if (cur && keepScroll) { const r = cur.offsetTop, h = cur.offsetHeight, L = this.$list; if (r < L.scrollTop) L.scrollTop = r - 8; else if (r + h > L.scrollTop + L.clientHeight) L.scrollTop = r + h - L.clientHeight + 8; }
    }
  }
  if (!customElements.get('cp-command-palette')) customElements.define('cp-command-palette', Palette);

  class Trigger extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode:'open' });
      root.innerHTML = `<style>
        :host{display:inline-flex}
        button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 10px 0 12px;border-radius:8px;cursor:pointer;min-width:190px;
          font:400 13px/1 'IBM Plex Sans',system-ui,sans-serif;border:1px solid var(--line2,#C7CDD1);background:var(--surface,#fff);color:var(--ink3,#7B858C)}
        button:hover{background:var(--surface2,#EDEFF0)}
        button:focus-visible{outline:2px solid var(--accent,#0F5C63);outline-offset:2px}
        svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round}
        span{flex:1} kbd{font:500 11px/1 'IBM Plex Mono',monospace;padding:4px 6px;border-radius:4px;border:1px solid var(--line2,#C7CDD1);color:var(--ink2,#5A646B)}
      </style><button type="button" aria-label="Open command palette"><svg viewBox="0 0 24 24"><path d="M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4"/></svg><span>Search or jump to…</span><kbd>Ctrl K</kbd></button>`;
      root.querySelector('button').addEventListener('click', () => window.cpPalette && window.cpPalette.open());
      if (/Mac|iPhone|iPad/.test(navigator.platform)) root.querySelector('kbd').textContent = '⌘K';
    }
  }
  if (!customElements.get('cp-command-trigger')) customElements.define('cp-command-trigger', Trigger);
})();
