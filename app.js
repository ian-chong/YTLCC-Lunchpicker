import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ── Firebase ──────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAP2grddLZSorLA0eXv0r2biEeNIjInP4s",
  authDomain: "ytlcc-lunch-picker.firebaseapp.com",
  databaseURL: "https://ytlcc-lunch-picker-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ytlcc-lunch-picker",
  storageBucket: "ytlcc-lunch-picker.firebasestorage.app",
  messagingSenderId: "172131785490",
  appId: "1:172131785490:web:7382a4a63b9a65b4d271cb"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// ── Google Sheet ──────────────────────────────────────────────────────────────
const SHEET_ID  = "1J6aLPFrsChdWeqX3CSfQ1Ce44EoxGyEIK5Bymsoh8Qo";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

// ── State ─────────────────────────────────────────────────────────────────────
let allItems      = [];
let filteredItems = [];
let hasVoted      = false;
let lastSessionTs = null;    // tracks createdAt to detect new sessions
let unsubscribe   = null;    // Firebase onValue unsubscriber

// ── CSV helpers ───────────────────────────────────────────────────────────────

// Parses full CSV text into rows of cells, correctly handling quoted multi-line fields
function parseCSVToRows(text) {
  const rows = [];
  let row = [], cur = "", inQ = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } // escaped quote
      else if (ch === '"')                   { inQ = false; }
      else                                   { cur += ch; }        // newlines inside quotes are kept
    } else {
      if      (ch === '"')  { inQ = true; }
      else if (ch === ',')  { row.push(cur.trim()); cur = ""; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(cur.trim()); rows.push(row); row = []; cur = ""; }
      else                  { cur += ch; }
    }
  }
  if (cur !== "" || row.length > 0) { row.push(cur.trim()); rows.push(row); }
  return rows;
}

function parseCSV(text) {
  const rows = parseCSVToRows(text);

  // Find the real header row (skip the title row)
  const headerIndex = rows.findIndex(row => row.includes("Name of Place"));
  if (headerIndex === -1) return [];

  const headers = rows[headerIndex];
  const items = rows.slice(headerIndex + 1)
    .map(cols => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i] ?? ""; });
      return obj;
    })
    .filter(item => item["Name of Place"]);

  // Location is only written once per group in the sheet — forward-fill it
  let lastLocation = "";
  items.forEach(item => {
    if (item.Location) { lastLocation = item.Location; }
    else               { item.Location = lastLocation; }
  });

  return items;
}

// Firebase keys cannot contain . # $ [ ] /
function toKey(name) {
  return name.replace(/[.#$[\]/]/g, "_");
}

// ── Sheet loading ─────────────────────────────────────────────────────────────
async function loadSheet() {
  try {
    const res = await fetch(SHEET_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    allItems = parseCSV(text);
    populateLocationFilter();
    applyFilters();
    document.getElementById("loading-overlay").classList.add("hidden");
  } catch (err) {
    console.error("Sheet load failed:", err);
    document.getElementById("loading-overlay").innerHTML =
      `<p style="text-align:center;padding:20px">
        ⚠️ Could not load lunch data.<br><br>
        Make sure the Google Sheet is shared as<br>
        <strong>"Anyone with the link – Viewer"</strong>.
      </p>`;
  }
}

function populateLocationFilter() {
  const sel = document.getElementById("filter-location");
  const locs = [...new Set(allItems.map(i => i.Location).filter(Boolean))].sort();
  locs.forEach(loc => {
    const opt = document.createElement("option");
    opt.value = loc;
    opt.textContent = loc;
    sel.appendChild(opt);
  });
}

// ── Filters ───────────────────────────────────────────────────────────────────
function applyFilters() {
  const location  = document.getElementById("filter-location").value;
  const wantHalal = document.getElementById("filter-halal").checked;
  const wantNH    = document.getElementById("filter-nonhalal").checked;
  const wantBAF   = document.getElementById("filter-baf").checked;
  const wantBT    = document.getElementById("filter-bt").checked;
  const wantPKB   = document.getElementById("filter-pkb").checked;

  filteredItems = allItems.filter(item => {
    // Location
    if (location && item.Location !== location) return false;

    // Diet
    const isHalal = item.Halal.trim() !== "";
    const isNH    = item["Non-Halal"].trim() !== "";
    if (isHalal  && !isNH  && !wantHalal) return false;
    if (isNH     && !isHalal && !wantNH)  return false;
    if (isHalal  && isNH && !wantHalal && !wantNH) return false;

    // Price — if no pricing info, always include
    const price = item.Pricing.toUpperCase();
    if (price) {
      const hasBAF = price.includes("BAF");
      const hasBT  = price.includes("BT");
      const hasPKB = price.includes("PKB");
      if (hasBAF || hasBT || hasPKB) {
        if (hasBAF && wantBAF) return true;
        if (hasBT  && wantBT)  return true;
        if (hasPKB && wantPKB) return true;
        return false;
      }
    }
    return true;
  });

  document.getElementById("random-count").textContent =
    `${filteredItems.length} option${filteredItems.length !== 1 ? "s" : ""} available`;
}

// ── Random mode ───────────────────────────────────────────────────────────────
function showResult(item) {
  document.getElementById("result-name").textContent     = item["Name of Place"];
  document.getElementById("result-location").textContent = item.Location ? `📍 ${item.Location}` : "";
  const p = item.Pricing.toUpperCase();
  const priceLabel = p.includes("BAF") ? "Broke AF (≤RM10)"
                   : p.includes("PKB") ? "Pocket Kena Bomb (RM15+)"
                   : p.includes("BT")  ? "Boleh Tahan (RM11–15)"
                   : "";
  document.getElementById("result-price").textContent   = priceLabel;
  document.getElementById("result-remarks").textContent = item.Remarks || "";
}

function spin() {
  if (filteredItems.length === 0) {
    alert("No options match your current filters!");
    return;
  }

  const btn  = document.getElementById("spin-btn");
  const card = document.getElementById("result-card");
  btn.disabled = true;
  card.classList.remove("winner");
  card.classList.add("spinning");

  let count = 0;
  const total = 22 + Math.floor(Math.random() * 10);

  function tick() {
    showResult(filteredItems[Math.floor(Math.random() * filteredItems.length)]);
    count++;
    if (count < total) {
      // Starts fast, slows down
      const t = count / total;
      const delay = t < 0.5 ? 55 : 55 + (t - 0.5) * 600;
      setTimeout(tick, delay);
    } else {
      const winner = filteredItems[Math.floor(Math.random() * filteredItems.length)];
      showResult(winner);
      card.classList.remove("spinning");
      card.classList.add("winner");
      btn.disabled = false;
    }
  }

  tick();
}

// ── Vote mode ─────────────────────────────────────────────────────────────────
const SESSION_REF = ref(db, "sessions/current");

function showVotePanel(id) {
  ["vote-lobby", "vote-session", "vote-results", "vote-checking"]
    .forEach(p => document.getElementById(p).classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

function initVoteTab() {
  if (unsubscribe) return;
  unsubscribe = onValue(SESSION_REF, snap => {
    const data = snap.val();
    if (!data) {
      hasVoted      = false;
      lastSessionTs = null;
      showVotePanel("vote-lobby");
    } else if (data.ended) {
      showFinalResults(data.options, data.votes);
    } else {
      // New session started — reset vote
      if (data.createdAt !== lastSessionTs) {
        hasVoted      = false;
        lastSessionTs = data.createdAt;
      }
      showVoteSession(data.options, data.votes);
    }
  });
}

async function createSession() {
  if (filteredItems.length === 0) {
    alert("No options match your current filters — adjust filters first.");
    return;
  }
  const options = filteredItems.map(i => ({
    name:     i["Name of Place"],
    location: i.Location || "",
    price:    i.Pricing  || "",
    remarks:  i.Remarks  || ""
  }));
  const votes = {};
  options.forEach(o => { votes[toKey(o.name)] = 0; });
  await set(SESSION_REF, { options, votes, ended: false, createdAt: Date.now() });
  // onValue fires automatically — no need to call showVoteSession manually
}

async function endSession() {
  await set(ref(db, "sessions/current/ended"), true);
}

async function resetSession() {
  await set(SESSION_REF, null);
  // onValue fires → shows lobby automatically
}

// ── Vote mode — rendering ────────────────────────────────────────────────────
function showVoteSession(options, votes) {
  showVotePanel("vote-session");
  const list = document.getElementById("vote-list");
  list.innerHTML = "";
  options.forEach(item => {
    const count = votes[toKey(item.name)] ?? 0;
    const div   = document.createElement("div");
    div.className = "vote-item";
    div.innerHTML = `
      <div class="vote-item-info">
        <div class="vote-item-name">${item.name}</div>
        <div class="vote-item-meta">📍 ${item.location}${item.price ? ` · ${item.price}` : ""}</div>
      </div>
      <span class="vote-count">${count}</span>
      <button class="vote-btn${hasVoted ? " voted" : ""}" data-name="${item.name}">
        ${hasVoted ? "✓" : "Vote"}
      </button>
    `;
    if (!hasVoted) {
      div.querySelector(".vote-btn").addEventListener("click", () => castVote(item.name));
    }
    list.appendChild(div);
  });
}

async function castVote(name) {
  if (hasVoted) return;
  hasVoted = true;
  await runTransaction(ref(db, `sessions/current/votes/${toKey(name)}`),
    cur => (cur || 0) + 1
  );
}

function showFinalResults(options, votes) {
  showVotePanel("vote-results");
  const sorted = options
    .map(item => ({ ...item, count: votes[toKey(item.name)] ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const max  = sorted[0]?.count || 1;
  const list = document.getElementById("results-list");
  list.innerHTML = "";
  sorted.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = `result-row${i === 0 ? " winner" : ""}`;
    row.innerHTML = `
      <span>${i === 0 ? "🏆" : i + 1 + "."}</span>
      <span class="result-row-name">${item.name}</span>
      <div class="bar-wrap"><div class="bar-fill" style="width:${(item.count / max) * 100}%"></div></div>
      <span class="result-votes">${item.count} vote${item.count !== 1 ? "s" : ""}</span>
    `;
    list.appendChild(row);
  });
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "vote") initVoteTab();
  });
});

["filter-location", "filter-halal", "filter-nonhalal", "filter-baf", "filter-bt", "filter-pkb"]
  .forEach(id => document.getElementById(id).addEventListener("change", applyFilters));

document.getElementById("spin-btn").addEventListener("click", spin);
document.getElementById("create-session-btn").addEventListener("click", createSession);
document.getElementById("end-session-btn").addEventListener("click", endSession);
document.getElementById("reset-session-btn").addEventListener("click", resetSession);

// ── Init ──────────────────────────────────────────────────────────────────────
loadSheet();
