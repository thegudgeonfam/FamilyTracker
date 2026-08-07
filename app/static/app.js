(() => {
  let data = null;
  let currentBoardId = null;
  let editingCard = null; // { boardId, card } or null for new
  let saveTimer = null;
  let dirty = false; // edits not yet confirmed saved
  let lastMeta = null; // latest /api/meta payload

  const el = (sel) => document.querySelector(sel);
  const tabsEl = el("#board-tabs");
  const descEl = el("#board-description");
  const columnsEl = el("#board-columns");
  const statusEl = el("#save-status");
  const modalEl = el("#card-modal");
  const modalBodyEl = el("#modal-body");
  const reviewBtn = el("#review-btn");
  const reviewModalEl = el("#review-modal");

  async function load() {
    const res = await fetch("/api/data");
    data = await res.json();
    if (!data.emailSync) data.emailSync = { pending: [], activity: [] };
    // Keep the user's current tab across refreshes; fall back to the first board.
    currentBoardId = data.boardOrder.includes(currentBoardId)
      ? currentBoardId
      : data.boardOrder[0];
    renderTabs();
    renderBoard();
    renderReviewButton();
    setStatus(idleText(), false);
  }

  function fmtWhen(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    if (d.toDateString() === new Date().toDateString())
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function idleText() {
    const iso =
      (lastMeta && lastMeta.lastRunAt) ||
      (data && data.emailSync && data.emailSync.lastRunAt);
    const when = fmtWhen(iso);
    return when ? `Up to date · email sync ${when}` : "Up to date";
  }

  function uiBusy() {
    return (
      dirty ||
      editingCard !== null ||
      !reviewModalEl.classList.contains("hidden")
    );
  }

  async function pollMeta() {
    if (!data) return;
    try {
      const res = await fetch("/api/meta", { cache: "no-store" });
      if (!res.ok) throw new Error();
      lastMeta = await res.json();
      if (uiBusy()) return; // never yank data out from under an edit
      if (lastMeta.revision !== data.revision) {
        await load();
        setStatus("Updated — pulled latest changes", false);
        setTimeout(() => {
          if (!uiBusy()) setStatus(idleText(), false);
        }, 4000);
      } else {
        setStatus(idleText(), false);
      }
    } catch (e) {
      setStatus("Can't reach tracker server", false, true);
    }
  }

  setInterval(pollMeta, 60 * 1000);
  window.addEventListener("focus", pollMeta);

  function setStatus(text, dirty, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle("dirty", !!dirty);
    statusEl.classList.toggle("error", !!isError);
  }

  async function save() {
    setStatus("Saving…", true);
    try {
      const res = await fetch("/api/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.status === 409) {
        // Someone else (the email sync, or the other account) wrote since we
        // loaded. Reload their version rather than overwrite it.
        dirty = false;
        await load();
        setStatus("Updated elsewhere — reloaded. Please re-apply your last change.", false, true);
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      if (body && typeof body.revision === "number") data.revision = body.revision;
      dirty = false;
      setStatus("Saved", false);
    } catch (e) {
      setStatus("Save failed — retrying…", false, true);
      scheduleSave();
    }
  }

  function scheduleSave() {
    dirty = true;
    setStatus("Unsaved changes…", true);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    data.boardOrder.forEach((id) => {
      const board = data.boards[id];
      const btn = document.createElement("button");
      btn.className = "board-tab" + (id === currentBoardId ? " active" : "");
      btn.textContent = `${board.icon || ""} ${board.name}`.trim();
      btn.addEventListener("click", () => {
        currentBoardId = id;
        renderTabs();
        renderBoard();
      });
      tabsEl.appendChild(btn);
    });
  }

  function daysBetween(dateStr) {
    if (!dateStr) return null;
    const then = new Date(dateStr);
    if (isNaN(then)) return null;
    const now = new Date();
    return Math.floor((now - then) / (1000 * 60 * 60 * 24));
  }

  function isOverdue(board, card) {
    const r = board.reminder;
    if (!r || r.mode !== "cadence") return false;
    const days = daysBetween(card.fields[r.dateField]);
    if (days === null) return false;
    const cadence = Number(card.fields[r.cadenceField]) || r.defaultCadence || 90;
    return days > cadence;
  }

  function fitScore(board, card) {
    if (!board.isChildcareBoard) return null;
    const scoreFields = board.fields.filter(
      (f) => f.type === "number" && /Score$/.test(f.key)
    );
    const nums = scoreFields
      .map((f) => card.fields[f.key])
      .filter((v) => v !== "" && v !== undefined && v !== null)
      .map(Number)
      .filter((v) => !isNaN(v));
    if (nums.length === 0) return null;
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    return Math.round(avg * 10) / 10;
  }

  function renderBoard() {
    const board = data.boards[currentBoardId];
    descEl.textContent = board.description || "";
    columnsEl.innerHTML = "";

    board.statuses.forEach((status) => {
      const col = document.createElement("div");
      col.className = "column";
      col.dataset.status = status;

      const header = document.createElement("div");
      header.className = "column-header";
      const cards = board.cards.filter((c) => c.status === status);
      header.innerHTML = `<span>${status}</span><span>${cards.length}</span>`;
      col.appendChild(header);

      cards.forEach((card) => col.appendChild(renderCard(board, card)));

      const addBtn = document.createElement("button");
      addBtn.className = "add-card-btn";
      addBtn.textContent = "+ Add card";
      addBtn.addEventListener("click", () => openModal(board, null, status));
      col.appendChild(addBtn);

      columnsEl.appendChild(col);
    });
  }

  function renderCard(board, card) {
    const div = document.createElement("div");
    div.className = "card";
    const title = card.fields[board.titleField] || "(untitled)";
    const badges = [];

    if (isOverdue(board, card)) badges.push(`<span class="badge overdue">Follow up</span>`);
    const score = fitScore(board, card);
    if (score !== null) badges.push(`<span class="badge score">Fit ${score}</span>`);

    div.innerHTML = `<div class="card-title"></div><div class="card-badges">${badges.join("")}</div>`;
    div.querySelector(".card-title").textContent = title;
    div.addEventListener("click", () => openModal(board, card, card.status));
    return div;
  }

  function openModal(board, card, status) {
    const isNew = !card;
    editingCard = { boardId: currentBoardId, card, isNew, status };

    const workingFields = isNew
      ? Object.fromEntries(board.fields.map((f) => [f.key, f.default ?? ""]))
      : { ...card.fields };

    el("#card-modal-heading").textContent = isNew
      ? "New card"
      : card.fields[board.titleField] || "(untitled)";

    modalBodyEl.innerHTML = "";

    const statusRow = document.createElement("div");
    statusRow.className = "field-row status-row";
    statusRow.innerHTML = `<label>Status</label>`;
    const statusSelect = document.createElement("select");
    board.statuses.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      if (s === status) opt.selected = true;
      statusSelect.appendChild(opt);
    });
    statusRow.appendChild(statusSelect);
    modalBodyEl.appendChild(statusRow);

    const inputs = {};
    board.fields.forEach((f) => {
      const row = document.createElement("div");
      row.className = "field-row";
      const label = document.createElement("label");
      label.textContent = f.label || f.key;
      row.appendChild(label);

      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        (f.options || []).forEach((optVal) => {
          const opt = document.createElement("option");
          opt.value = optVal;
          opt.textContent = optVal || "(blank)";
          if (workingFields[f.key] === optVal) opt.selected = true;
          input.appendChild(opt);
        });
      } else if (f.type === "textarea") {
        input = document.createElement("textarea");
        input.value = workingFields[f.key] ?? "";
      } else {
        input = document.createElement("input");
        input.type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
        input.value = workingFields[f.key] ?? "";
      }
      row.appendChild(input);
      modalBodyEl.appendChild(row);
      inputs[f.key] = input;
    });

    editingCard.statusSelect = statusSelect;
    editingCard.inputs = inputs;

    el("#modal-delete").style.display = isNew ? "none" : "";
    modalEl.classList.remove("hidden");
  }

  function closeModal() {
    modalEl.classList.add("hidden");
    editingCard = null;
  }

  function commitModal() {
    const board = data.boards[editingCard.boardId];
    const fields = {};
    for (const [key, input] of Object.entries(editingCard.inputs)) {
      fields[key] = input.value;
    }
    const status = editingCard.statusSelect.value;

    if (editingCard.isNew) {
      const id = Math.random().toString(36).slice(2, 10);
      board.cards.push({
        id,
        status,
        createdAt: new Date().toISOString().slice(0, 10),
        fields,
      });
    } else {
      editingCard.card.status = status;
      editingCard.card.fields = fields;
    }

    closeModal();
    renderBoard();
    scheduleSave();
  }

  function deleteCard() {
    if (editingCard.isNew) { closeModal(); return; }
    if (!confirm("Delete this card? This can't be undone from the UI (git history still has it).")) return;
    const board = data.boards[editingCard.boardId];
    board.cards = board.cards.filter((c) => c !== editingCard.card);
    closeModal();
    renderBoard();
    scheduleSave();
  }

  el("#modal-close").addEventListener("click", closeModal);
  el("#modal-save").addEventListener("click", commitModal);
  el("#modal-delete").addEventListener("click", deleteCard);
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeModal();
  });

  // ---------- Email review inbox ----------

  function findCard(boardId, cardId) {
    const board = data.boards[boardId];
    if (!board) return null;
    return board.cards.find((c) => c.id === cardId) || null;
  }

  function renderReviewButton() {
    const pending = data.emailSync.pending || [];
    el("#review-count").textContent = pending.length;
    reviewBtn.classList.toggle("hidden", pending.length === 0);
  }

  function openReview() {
    const es = data.emailSync;
    const pending = es.pending || [];
    const sub = el("#review-sub");
    sub.textContent = pending.length
      ? `${pending.length} email${pending.length > 1 ? "s" : ""} need${pending.length > 1 ? "" : "s"} your call. Confirm the card(s) to update, or dismiss.`
      : "Nothing waiting for review.";

    const container = el("#review-pending");
    container.innerHTML = "";

    pending.forEach((item) => {
      const box = document.createElement("div");
      box.className = "review-item";

      const head = document.createElement("div");
      head.className = "review-head";
      head.innerHTML =
        `<div class="review-subject"></div>` +
        `<div class="review-meta"></div>`;
      head.querySelector(".review-subject").textContent = item.subject || "(no subject)";
      head.querySelector(".review-meta").textContent =
        `${item.from} · ${(item.receivedAt || "").slice(0, 10)}`;
      box.appendChild(head);

      const snippet = document.createElement("div");
      snippet.className = "review-snippet";
      snippet.textContent = item.snippet || "";
      box.appendChild(snippet);

      const reason = document.createElement("div");
      reason.className = "review-reason";
      reason.textContent = item.reason || "";
      box.appendChild(reason);

      const hasCandidates = (item.candidates || []).length > 0;

      const candWrap = document.createElement("div");
      candWrap.className = "review-candidates";
      if (!hasCandidates) {
        const note = document.createElement("div");
        note.className = "review-nocard";
        note.textContent = "No card to update — informational only.";
        candWrap.appendChild(note);
      }
      item.candidates.forEach((cand, idx) => {
        const row = document.createElement("label");
        row.className = "review-cand";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!cand.selected;
        cb.dataset.idx = idx;

        const name = document.createElement("span");
        name.className = "review-cand-name";
        name.textContent = cand.cardName;

        const sel = document.createElement("select");
        const board = data.boards[cand.boardId];
        (board ? board.statuses : []).forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s;
          opt.textContent = s;
          if (s === (cand.suggestedStatus || cand.currentStatus)) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.dataset.idx = idx;

        const from = document.createElement("span");
        from.className = "review-cand-from";
        from.textContent = `now: ${cand.currentStatus}`;

        row.append(cb, name, from, document.createTextNode("→"), sel);
        candWrap.appendChild(row);
      });
      box.appendChild(candWrap);

      const actions = document.createElement("div");
      actions.className = "review-actions";
      const dismissBtn = document.createElement("button");
      dismissBtn.className = "btn";
      dismissBtn.textContent = hasCandidates ? "Dismiss" : "Got it";
      dismissBtn.addEventListener("click", () => dismissReviewItem(item));
      if (hasCandidates) {
        const confirmBtn = document.createElement("button");
        confirmBtn.className = "btn btn-primary";
        confirmBtn.textContent = "Apply selected";
        confirmBtn.addEventListener("click", () => applyReviewItem(item, box));
        actions.append(dismissBtn, confirmBtn);
      } else {
        actions.append(dismissBtn);
      }
      box.appendChild(actions);

      container.appendChild(box);
    });

    renderActivity();
    reviewModalEl.classList.remove("hidden");
  }

  function renderActivity() {
    const activity = (data.emailSync.activity || []).slice().reverse().slice(0, 20);
    const wrap = el("#review-activity");
    if (activity.length === 0) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = `<h3 class="review-activity-h">Recently applied automatically</h3>`;
    activity.forEach((a) => {
      const row = document.createElement("div");
      row.className = "activity-row";
      const change = a.change ? ` — ${a.change}` : "";
      row.innerHTML = `<span class="activity-card"></span><span class="activity-change"></span>`;
      row.querySelector(".activity-card").textContent = a.cardName || a.subject || "";
      row.querySelector(".activity-change").textContent = change;
      wrap.appendChild(row);
    });
  }

  function applyReviewItem(item, box) {
    const checkboxes = box.querySelectorAll('input[type="checkbox"]');
    const selects = box.querySelectorAll("select");
    const applied = [];
    checkboxes.forEach((cb) => {
      if (!cb.checked) return;
      const idx = Number(cb.dataset.idx);
      const cand = item.candidates[idx];
      const newStatus = selects[idx].value;
      const card = findCard(cand.boardId, cand.cardId);
      if (!card) return;
      const prev = card.status;
      if (newStatus !== prev) {
        card.status = newStatus;
        if (card.fields && "confirmationReceived" in card.fields)
          card.fields.confirmationReceived = "Yes";
        if (card.fields && "lastReconfirm" in card.fields)
          card.fields.lastReconfirm = (item.receivedAt || "").slice(0, 10);
      }
      applied.push({ cardName: cand.cardName, change: `${prev} → ${newStatus}` });
    });

    applied.forEach((a) =>
      data.emailSync.activity.push({
        at: new Date().toISOString(),
        action: "confirmed",
        from: item.from,
        subject: item.subject,
        threadId: item.threadId,
        cardName: a.cardName,
        change: a.change,
      })
    );
    data.emailSync.pending = data.emailSync.pending.filter((p) => p.id !== item.id);

    renderBoard();
    renderReviewButton();
    openReview();
    scheduleSave();
  }

  function dismissReviewItem(item) {
    data.emailSync.activity.push({
      at: new Date().toISOString(),
      action: "dismissed",
      from: item.from,
      subject: item.subject,
      threadId: item.threadId,
      cardName: "(dismissed — no change)",
      change: "",
    });
    data.emailSync.pending = data.emailSync.pending.filter((p) => p.id !== item.id);
    renderReviewButton();
    openReview();
    scheduleSave();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!modalEl.classList.contains("hidden")) closeModal();
    reviewModalEl.classList.add("hidden");
  });

  reviewBtn.addEventListener("click", openReview);
  el("#review-close").addEventListener("click", () => reviewModalEl.classList.add("hidden"));
  reviewModalEl.addEventListener("click", (e) => {
    if (e.target === reviewModalEl) reviewModalEl.classList.add("hidden");
  });

  load();
})();
