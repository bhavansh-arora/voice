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

// Adds a "Sign out" link to the nav bar on every admin page, so it never
// has to be hand-added to each page's markup.
document.addEventListener("DOMContentLoaded", () => {
  const nav = document.querySelector(".nav");
  if (!nav) return;
  const signOut = document.createElement("a");
  signOut.href = "#";
  signOut.textContent = "Sign out";
  signOut.style.marginLeft = "auto";
  signOut.addEventListener("click", (e) => {
    e.preventDefault();
    AdminApp.logout();
  });
  nav.appendChild(signOut);
});
