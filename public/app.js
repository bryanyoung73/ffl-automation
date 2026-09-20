function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmt1(n) {
  return typeof n === "number" ? n.toFixed(1) : "";
}

async function fetchJson(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `${path} failed (${res.status})`);
  return body;
}

function renderLineup(view) {
  const rows = view.plan.assignments
    .map((a) => {
      const p = a.player;
      if (!p) return `<tr><td>${escapeHtml(a.slot.code)}</td><td class="muted">— empty —</td><td></td><td></td></tr>`;
      const status = p.locked ? "LOCK" : p.status !== "OK" ? escapeHtml(p.status) : "";
      return `<tr><td>${escapeHtml(a.slot.code)}</td><td>${escapeHtml(p.name)}</td><td>${fmt1(p.projectedPoints)}</td><td>${status}</td></tr>`;
    })
    .join("");

  const bench = view.plan.bench
    .map((p) => `${escapeHtml(p.name)} (${fmt1(p.projectedPoints)})`)
    .join(", ");

  // A submit is only actually needed when the *set* of starters changes.
  // diffLineup still lists pure slot-label reshuffles among the same
  // starters (RB <-> W/R/T) in `changes` for completeness, but those aren't
  // real recommendations -- needsSubmit is what set-lineup.ts itself gates
  // on, so the dashboard must match it rather than keying off changes.length.
  let changes = "";
  if (view.diff.needsSubmit) {
    const changeRows = view.diff.changes
      .map(
        (c) =>
          `<tr><td>${escapeHtml(c.player.name)}</td><td>${escapeHtml(c.fromSlot)}</td><td>${escapeHtml(c.toSlot)}</td><td>${fmt1(c.player.projectedPoints)}</td></tr>`,
      )
      .join("");
    changes = `
      <h3>Proposed changes</h3>
      <table><thead><tr><th>Player</th><th>From</th><th>To</th><th>Proj</th></tr></thead><tbody>${changeRows}</tbody></table>
      <p>Projected: ${fmt1(view.diff.currentProjected)} &rarr; ${fmt1(view.diff.proposedProjected)}
        (${view.diff.delta >= 0 ? "+" : ""}${fmt1(view.diff.delta)})</p>`;
  } else if (view.diff.changes.length) {
    changes = `<p class="muted">Lineup is already optimal (proposed moves are cosmetic slot swaps). Nothing to submit.</p>`;
  } else {
    changes = `<p class="muted">Lineup is already optimal. Nothing to do.</p>`;
  }

  const adjustments = view.adjustments.length
    ? `<h3>Intel adjustments</h3><ul>${view.adjustments
        .map((a) => {
          const note = a.notes[0] && a.notes[0].text ? ` — ${escapeHtml(a.notes[0].text)}` : "";
          return `<li>${escapeHtml(a.name)}: ${fmt1(a.from)} &rarr; ${fmt1(a.to)}${note}</li>`;
        })
        .join("")}</ul>`
    : "";

  return `
    <table><thead><tr><th>Slot</th><th>Player</th><th>Proj</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <p><strong>Total: ${fmt1(view.plan.totalProjected)}</strong></p>
    ${bench ? `<p class="muted">Bench: ${bench}</p>` : ""}
    ${changes}
    ${adjustments}`;
}

function renderPair(p) {
  const dropLine = p.drop
    ? `<div class="drop">DROP ${escapeHtml(p.drop.name)} (${escapeHtml(p.drop.position)})</div>`
    : "";
  return `
    <div class="pair">
      <div class="add">ADD ${escapeHtml(p.add.name)} (${escapeHtml(p.add.position)}, ${escapeHtml(p.add.team)})
        <span class="muted">ROS ${p.addValue.rosVal} · wk ${p.addValue.weekVal} · ${p.add.pctOwned.toFixed(0)}% owned${p.add.availability === "WAIVERS" ? " · WAIVER" : ""}</span>
      </div>
      <div class="reason">${escapeHtml(p.reason)}</div>
      ${dropLine}
      <div class="gain">net ${p.gain >= 0 ? "+" : ""}${p.gain} value</div>
    </div>`;
}

function renderWaivers(view) {
  if (view.unavailable) {
    return `<p class="muted">${escapeHtml(view.reason)}</p>`;
  }

  const pairs = view.pairs.length
    ? view.pairs.map(renderPair).join("")
    : `<p class="muted">No add worth a roster move right now.</p>`;

  const streaming = view.streaming.length
    ? `<h3>Streaming (this week only)</h3>${view.streaming.map(renderPair).join("")}`
    : "";

  const skipped = view.skippedPositions.length
    ? `<p class="muted">Nothing worth adding at ${view.skippedPositions.map(escapeHtml).join(", ")} — your bench beats the pool.</p>`
    : "";

  return `${pairs}${streaming}${skipped}`;
}

async function loadLineup() {
  const el = document.getElementById("lineup-body");
  el.textContent = "Loading…";
  try {
    const view = await fetchJson("/api/lineup");
    document.getElementById("meta").textContent = `${view.provider}${view.week ? ` · week ${view.week}` : ""} · updated ${new Date().toLocaleTimeString()}`;
    el.innerHTML = renderLineup(view);
  } catch (err) {
    el.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

async function loadWaivers() {
  const el = document.getElementById("waivers-body");
  el.textContent = "Loading…";
  try {
    const view = await fetchJson("/api/waivers");
    el.innerHTML = renderWaivers(view);
  } catch (err) {
    el.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

document.querySelectorAll("[data-refresh]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.refresh === "lineup") loadLineup();
    else loadWaivers();
  });
});

loadLineup();
loadWaivers();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
