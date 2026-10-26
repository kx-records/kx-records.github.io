(() => {
  const state = { user: null, demos: [], users: [], filter: "all" };
  const apiBase = (window.KX_API_BASE_URL || "").replace(/\/$/, "");
  const apiUrl = (path) => `${apiBase}${path}`;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value = "") => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  const roleName = (role) => ({ artist: "Artist", ar: "A&R", manager: "Manager", owner: "Owner", developer: "Developer" })[role] || role;
  const staffRoles = ["ar", "manager", "owner", "developer"];
  const ownerPower = (role) => ["owner", "developer"].includes(role);

  async function api(path, options = {}) {
    const response = await fetch(apiUrl(path), { ...options, credentials: "include", headers: { Accept: "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.replace("/#account");
      throw new Error("Session ended");
    }
    if (!response.ok) throw new Error(body.error || "Request failed.");
    return body;
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

  function renderDemos() {
    const demos = state.filter === "all" ? state.demos : state.demos.filter((demo) => demo.status === state.filter);
    $("#demo-list").innerHTML = demos.length ? demos.map((demo) => `
      <article class="demo-row">
        <div class="demo-row-head">
          <div><h4>${escapeHtml(demo.trackTitle)}</h4><div class="demo-meta">${escapeHtml(demo.artistName)} · ${escapeHtml(demo.genre)} · ${escapeHtml(demo.user)}</div></div>
          <span class="status-pill ${demo.status}">${demo.status}</span>
        </div>
        <div class="demo-details">
          ${demo.message ? `<p>${escapeHtml(demo.message)}</p>` : ""}
          ${demo.link ? `<a class="button button-outline button-small" href="${escapeHtml(demo.link)}" target="_blank" rel="noopener">Listen ↗</a>` : ""}
          ${demo.fileName ? `<a class="button button-outline button-small" href="${apiUrl(`/api/demos/${demo.id}/file`)}">Download</a>` : ""}
          ${staffRoles.includes(state.user.role) ? `<div class="review-actions"><button class="button button-small" data-review="approved" data-id="${demo.id}">Approve</button><button class="button button-outline button-small" data-review="rejected" data-id="${demo.id}">Reject</button><button class="button button-outline button-small" data-review="pending" data-id="${demo.id}">Reset</button></div>` : ""}
          ${demo.reviewerName ? `<div class="demo-meta">Reviewed by ${escapeHtml(demo.reviewerName)}</div>` : ""}
        </div>
      </article>`).join("") : '<div class="empty-state">No submissions in this view.</div>';
  }

  function renderStaff() {
    const canAssignOwnerRoles = ownerPower(state.user.role);
    $("#staff-list").innerHTML = state.users.map((user) => {
      const promotable = !ownerPower(user.role) && (canAssignOwnerRoles || state.user.role === "manager");
      return `<div class="staff-row"><div><strong>${escapeHtml(user.name)}</strong><div class="staff-meta">${escapeHtml(user.email)} · ${roleName(user.role)}</div></div>
        ${promotable ? `<select aria-label="Role for ${escapeHtml(user.name)}" data-role-user="${user.id}">
          ${["artist", "ar", ...(canAssignOwnerRoles ? ["manager", "developer"] : [])].map((role) => `<option value="${role}" ${user.role === role ? "selected" : ""}>${roleName(role)}</option>`).join("")}
        </select>` : ""}</div>`;
    }).join("");
  }

  async function initialize() {
    try {
      const { user } = await api("/api/me");
      state.user = user;
      $("#session-status").textContent = roleName(user.role);
      $("#dashboard-user").textContent = `${user.name} · ${user.email}`;
      await loadDemos();
      if (staffRoles.includes(user.role)) {
        $("#staff-panel").hidden = false;
        await loadUsers();
      }
    } catch (error) {
      if (error.message !== "Session ended") $("#demo-list").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  $("#logout-button").addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } finally { window.location.replace("/"); }
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
    try { await api(`/api/demos/${button.dataset.id}/review`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: button.dataset.review }) }); await loadDemos(); }
    catch (error) { alert(error.message); }
  });

  $("#staff-list").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-role-user]");
    if (!select) return;
    try {
      await api(`/api/users/${select.dataset.roleUser}/role`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: select.value }) });
      await loadUsers();
    } catch (error) { alert(error.message); select.value = state.users.find((user) => user.id === select.dataset.roleUser)?.role || "artist"; }
  });

  initialize();
})();
