(() => {
  const state = { user: null, demos: [], users: [], filter: "all" };
  const apiBase = (window.KX_API_BASE_URL || "").replace(/\/$/, "");
  const apiUrl = (path) => `${apiBase}${path}`;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value = "") => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  const roleName = (role) => ({ artist: "Artist", ar: "A&R", manager: "Manager", owner: "Owner", developer: "Developer" })[role] || role;
  const staffRoles = ["ar", "manager", "owner", "developer"];
  const ownerPower = (role) => ["owner", "developer"].includes(role);

  const authBackdrop = $("#auth-backdrop");
  const portal = $("#portal-drawer");

  function openAuth() {
    authBackdrop.classList.add("is-open");
    document.body.classList.add("portal-open");
  }
  function closeAuth() {
    authBackdrop.classList.remove("is-open");
  }
  function switchAuth(tab) {
    document.querySelectorAll(".auth-tab").forEach((button) => button.classList.toggle("is-active", button.dataset.tab === tab));
    $("#login-form").hidden = tab !== "login";
    $("#register-form").hidden = tab !== "register";
  }

  async function api(path, options = {}) {
    const response = await fetch(apiUrl(path), { ...options, credentials: "include", headers: { "Accept": "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Request failed.");
    return body;
  }

  async function refresh() {
    const { user } = await api("/api/me");
    state.user = user;
    if (!user) {
      $("#account-button").textContent = "Account";
      portal.classList.remove("is-open");
      return;
    }
    $("#account-button").textContent = "Dashboard";
    $("#portal-name").textContent = user.name;
    $("#portal-role").textContent = roleName(user.role);
    $("#submit-panel").hidden = !["artist", ...staffRoles].includes(user.role);
    $("#staff-panel").hidden = !staffRoles.includes(user.role);
    if (staffRoles.includes(user.role)) await loadUsers();
    await loadDemos();
  }

  async function loadDemos() {
    const { demos } = await api("/api/demos");
    state.demos = demos;
    renderDemos();
  }

  async function loadUsers() {
    const { users } = await api("/api/users");
    state.users = users;
    renderStaff();
  }

  function filteredDemos() {
    return state.filter === "all" ? state.demos : state.demos.filter((demo) => demo.status === state.filter);
  }

  function renderDemos() {
    const staff = staffRoles.includes(state.user.role);
    const demos = filteredDemos();
    $("#demo-list").innerHTML = demos.length ? demos.map((demo) => `
      <article class="demo-row">
        <div class="demo-row-head">
          <div><h4>${escapeHtml(demo.trackTitle)}</h4><div class="demo-meta">${escapeHtml(demo.artistName)} · ${escapeHtml(demo.genre)}${staff ? ` · ${escapeHtml(demo.user)}` : ""}</div></div>
          <span class="status-pill ${demo.status}">${demo.status}</span>
        </div>
        <div class="demo-details">
          ${demo.message ? `<p>${escapeHtml(demo.message)}</p>` : ""}
          ${demo.link ? `<a class="button button-outline button-small" href="${escapeHtml(demo.link)}" target="_blank" rel="noopener">Listen ↗</a>` : ""}
          ${demo.fileName ? `<a class="button button-outline button-small" href="${apiUrl(`/api/demos/${demo.id}/file`)}" target="_blank" rel="noopener">Download</a>` : ""}
          ${staff ? `<div class="review-actions"><button class="button button-small" data-review="approved" data-id="${demo.id}">Approve</button><button class="button button-outline button-small" data-review="rejected" data-id="${demo.id}">Reject</button><button class="button button-outline button-small" data-review="pending" data-id="${demo.id}">Reset</button></div>` : ""}
          ${demo.reviewerName ? `<div class="demo-meta">Reviewed by ${escapeHtml(demo.reviewerName)}</div>` : ""}
        </div>
      </article>`).join("") : '<div class="empty-state">No submissions in this view.</div>';
  }

  function renderStaff() {
    const ownerPowerActive = ownerPower(state.user.role);
    $("#staff-list").innerHTML = state.users.map((user) => {
      const promotable = !ownerPower(user.role) && (ownerPowerActive || state.user.role === "manager");
      return `<div class="staff-row"><div><strong>${escapeHtml(user.name)}</strong><div class="staff-meta">${escapeHtml(user.email)} · ${roleName(user.role)}</div></div>
        ${promotable ? `<select aria-label="Role for ${escapeHtml(user.name)}" data-role-user="${user.id}">
          ${["artist", "ar", ...(ownerPowerActive ? ["manager", "developer"] : [])].map((role) => `<option value="${role}" ${user.role === role ? "selected" : ""}>${roleName(role)}</option>`).join("")}
        </select>` : ""}</div>`;
    }).join("");
  }

  async function submitAuth(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector(".auth-status");
    const data = Object.fromEntries(new FormData(form));
    status.textContent = "";
    try {
      await api(form.dataset.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      form.reset(); closeAuth(); await refresh(); portal.classList.add("is-open");
      if (form.id === "demo-auth-form") $("#demo-form").scrollIntoView({ behavior: "smooth" });
    } catch (error) { status.textContent = error.message; }
  }

  $("#account-button").addEventListener("click", () => state.user ? portal.classList.toggle("is-open") : openAuth());
  $("#close-auth").addEventListener("click", closeAuth);
  $("#close-portal").addEventListener("click", () => portal.classList.remove("is-open"));
  $("#login-form").addEventListener("submit", submitAuth);
  $("#register-form").addEventListener("submit", submitAuth);
  document.querySelectorAll(".auth-tab").forEach((button) => button.addEventListener("click", () => switchAuth(button.dataset.tab)));
  authBackdrop.addEventListener("click", (event) => { if (event.target === authBackdrop) closeAuth(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeAuth(); portal.classList.remove("is-open"); } });

  $("#logout-button").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    await refresh();
  });
  window.addEventListener("kx:demos-updated", () => {
    if (state.user) loadDemos().catch(() => {});
  });
  $("#demo-filter").addEventListener("click", (event) => {
    if (!event.target.dataset.filter) return;
    state.filter = event.target.dataset.filter;
    document.querySelectorAll("#demo-filter button").forEach((button) => button.classList.toggle("button-outline", button !== event.target));
    renderDemos();
  });
  $("#demo-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-review]");
    if (!button) return;
    try {
      await api(`/api/demos/${button.dataset.id}/review`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: button.dataset.review }) });
      await loadDemos();
    } catch (error) { alert(error.message); }
  });
  $("#staff-list").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-role-user]");
    if (!select) return;
    try {
      await api(`/api/users/${select.dataset.roleUser}/role`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: select.value }) });
      await loadUsers();
    } catch (error) { alert(error.message); select.value = state.users.find((user) => user.id === select.dataset.roleUser)?.role || "artist"; }
  });

  refresh().catch(() => {});
})();
