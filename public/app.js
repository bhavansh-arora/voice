// Shared helpers for the admin pages. Auth is a signed-in session cookie
// (set by login.html via POST /api/login) - the browser sends it
// automatically on every same-origin request, including the /dashboard
// WebSocket handshake, so there's no token to carry through URLs or
// sessionStorage at all.
const AdminApp = (() => {
  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (body && typeof body !== "string" && !(body instanceof Blob)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await fetch(`/api${path}`, { ...options, headers, body });
    if (res.status === 401) {
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error("Not signed in");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res;
  }

  async function apiJson(path, options) {
    const res = await api(path, options);
    return res.json();
  }

  function wsUrl(path, params = {}) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = new URLSearchParams(params).toString();
    return `${proto}//${location.host}${path}${qs ? `?${qs}` : ""}`;
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    location.href = "/login.html";
  }

  return { api, apiJson, wsUrl, logout };
})();

// Which agent the admin UI is currently working with, shared across pages
// (same tab) via localStorage so navigating between pages keeps it.
const AgentContext = {
  get: () => localStorage.getItem("currentAgentId") || "",
  set: (id) => localStorage.setItem("currentAgentId", id),
};

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// --- Sidebar shell -----------------------------------------------------
// Every admin page (except login) renders the same left sidebar + mobile
// topbar/drawer. Built here once instead of duplicated in every HTML file,
// so adding/renaming a nav item only happens in one place.

const ICONS = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  setup: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="#fff"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="#fff"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2" fill="#fff"/>',
  voices: '<rect x="3" y="9" width="2.6" height="6" rx="1.3" fill="currentColor" stroke="none"/><rect x="8.2" y="5" width="2.6" height="14" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.4" y="2" width="2.6" height="20" rx="1.3" fill="currentColor" stroke="none"/><rect x="18.6" y="7" width="2.6" height="10" rx="1.3" fill="currentColor" stroke="none"/>',
  telephony: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>',
  calls: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>',
  test: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

function svgIcon(name, extraAttrs = "") {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extraAttrs}>${ICONS[name] || ""}</svg>`;
}

const NAV_ITEMS = [
  { href: "index.html", label: "Home", icon: "home" },
  { href: "setup.html", label: "Setup", icon: "setup" },
  { href: "voices.html", label: "Voices", icon: "voices" },
  { href: "telephony.html", label: "Telephony", icon: "telephony" },
  { href: "calls.html", label: "Calls", icon: "calls" },
  { href: "dashboard.html", label: "Test", icon: "test" },
];

function currentPageFile() {
  const name = location.pathname.split("/").pop();
  return name === "" ? "index.html" : name;
}

function renderSidebarShell() {
  // login.html doesn't load app.js at all, so this only ever runs on
  // pages that should have the shell.
  document.body.classList.add("app-shell");
  const active = currentPageFile();

  const navHtml = NAV_ITEMS.map(
    (item) => `
    <a href="${item.href}" class="${item.href === active ? "active" : ""}">
      ${svgIcon(item.icon)}
      <span>${item.label}</span>
    </a>`
  ).join("");

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.id = "appSidebar";
  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <div class="mark">V</div>
      <span class="name">Voice Agent</span>
    </div>
    <div class="sidebar-agent" id="sidebarAgentBox" style="display:none">
      <label>Agent</label>
      <select id="sidebarAgentPicker"></select>
    </div>
    <nav class="sidebar-nav">${navHtml}</nav>
    <div class="sidebar-footer">
      <button type="button" id="sidebarSignOut">${svgIcon("logout")}<span>Sign out</span></button>
    </div>
  `;

  const backdrop = document.createElement("div");
  backdrop.className = "sidebar-backdrop";
  backdrop.id = "sidebarBackdrop";

  const topbar = document.createElement("div");
  topbar.className = "topbar";
  topbar.innerHTML = `
    <div class="brand"><div class="mark">V</div>Voice Agent</div>
    <button type="button" class="menu-btn" id="topbarMenuBtn" aria-label="Menu">${svgIcon("menu")}</button>
  `;

  document.body.prepend(backdrop);
  document.body.prepend(topbar);
  document.body.prepend(sidebar);

  function closeDrawer() {
    sidebar.classList.remove("open");
    backdrop.classList.remove("show");
  }
  document.getElementById("topbarMenuBtn").addEventListener("click", () => {
    sidebar.classList.add("open");
    backdrop.classList.add("show");
  });
  backdrop.addEventListener("click", closeDrawer);
  sidebar.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeDrawer));

  document.getElementById("sidebarSignOut").addEventListener("click", () => AdminApp.logout());

  // Agent switcher - only shown once at least one agent exists. Switching
  // just reloads the current page under the new agent id; pages that
  // require one (everything except Home) read it fresh on load.
  AdminApp.apiJson("/agents")
    .then((agents) => {
      if (!agents.length) return;
      const box = document.getElementById("sidebarAgentBox");
      const picker = document.getElementById("sidebarAgentPicker");
      box.style.display = "";
      picker.innerHTML = agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
      const current = AgentContext.get();
      if (current && agents.some((a) => a.id === current)) picker.value = current;
      else AgentContext.set(picker.value);
      picker.addEventListener("change", () => {
        AgentContext.set(picker.value);
        location.reload();
      });
    })
    .catch(() => {});
}

document.addEventListener("DOMContentLoaded", renderSidebarShell);
