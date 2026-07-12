(() => {
  let data = null;
  let currentBoardId = null;
  let editingCard = null; // { boardId, card } or null for new
  let saveTimer = null;

  const el = (sel) => document.querySelector(sel);
  const tabsEl = el("#board-tabs");
  const descEl = el("#board-description");
  const columnsEl = el("#board-columns");
  const statusEl = el("#save-status");
  const modalEl = el("#card-modal");
  const modalBodyEl = el("#modal-body");

  async function load() {
    const res = await fetch("/api/data");
    data = await res.json();
    currentBoardId = data.boardOrder[0];
    renderTabs();
    renderBoard();
    setStatus("Loaded", false);
  }

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
      if (!res.ok) throw new Error(await res.text());
      setStatus("Saved", false);
    } catch (e) {
      setStatus("Save failed — retrying…", false, true);
      scheduleSave();
    }
  }

  function scheduleSave() {
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

  load();
})();
