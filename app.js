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
let currentSession = null;
let isHost         = false;
let hasVoted       = false;
let unsubscribe    = null;   // Firebase onValue unsubscriber

// ── CSV helpers ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const cols = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"')      { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur); cur = ""; }
    else                 { cur += ch; }
  }
  cols.push(cur);
  return cols.map(c => c.trim().replace(/^"|"$/g, ""));
}

function parseCSV(text) {
  const [headerLine, ...rows] = text.trim().split("\n");
  const headers = parseCSVLine(headerLine);
  return rows
    .map(row => {
      const cols = parseCSVLine(row);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i] ?? ""; });
      return obj;
    })
    .filter(item => item["Name of Place"]);
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
  const priceLabel = p.includes("BAF") ? "BAF ≤RM10"
                   : p.includes("PKB") ? "PKB RM15+"
                   : p.includes("BT")  ? "BT RM11–15"
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

// ── Vote mode — session management ───────────────────────────────────────────
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function createSession() {
  if (filteredItems.length === 0) {
    alert("No options match your current filters — adjust filters before creating a session.");
    return;
  }

  const code = generateCode();
  isHost   = true;
  hasVoted = false;
  currentSession = code;

  const options = filteredItems.map(i => ({
    name:     i["Name of Place"],
    location: i.Location    || "",
    price:    i.Pricing     || "",
    remarks:  i.Remarks     || ""
  }));

  const votes = {};
  options.forEach(o => { votes[toKey(o.name)] = 0; });

  await set(ref(db, `sessions/${code}`), {
    options,
    votes,
    ended: false,
    createdAt: Date.now()
  });

  enterSession(code);
}

async function joinSession() {
  const code = document.getElementById("join-code-input").value.trim().toUpperCase();
  if (!code) return;

  const snap = await get(ref(db, `sessions/${code}`));
  if (!snap.exists()) {
    alert("Room not found — check the code and try again.");
    return;
  }
  if (snap.val().ended) {
    alert("That session has already ended.");
    return;
  }

  isHost   = false;
  hasVoted = false;
  currentSession = code;
  enterSession(code);
}

function enterSession(code) {
  document.getElementById("vote-lobby").classList.add("hidden");
  document.getElementById("vote-session").classList.remove("hidden");
  document.getElementById("room-code-label").textContent = code;

  if (isHost) {
    document.getElementById("end-session-btn").classList.remove("hidden");
  }

  if (unsubscribe) unsubscribe();
  unsubscribe = onValue(ref(db, `sessions/${code}`), snap => {
    const data = snap.val();
    if (!data) return;
    if (data.ended) {
      showFinalResults(data.options, data.votes);
    } else {
      renderVoteList(data.options, data.votes);
    }
  });
}

// ── Vote mode — rendering ────────────────────────────────────────────────────
function renderVoteList(options, votes) {
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
  if (hasVoted || !currentSession) return;
  hasVoted = true;
  await runTransaction(ref(db, `sessions/${currentSession}/votes/${toKey(name)}`),
    cur => (cur || 0) + 1
  );
}

async function endSession() {
  if (!isHost || !currentSession) return;
  await set(ref(db, `sessions/${currentSession}/ended`), true);
}

function showFinalResults(options, votes) {
  document.getElementById("vote-list").classList.add("hidden");
  document.getElementById("end-session-btn").classList.add("hidden");
  document.getElementById("vote-results").classList.remove("hidden");

  const sorted = options
    .map(item => ({ ...item, count: votes[toKey(item.name)] ?? 0 }))
    .sort((a, b) => b.count - a.count);

  const max = sorted[0]?.count || 1;
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

// ── Copy shareable link ───────────────────────────────────────────────────────
function copyLink() {
  if (!currentSession) return;
  const url = `${location.origin}${location.pathname}?room=${currentSession}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById("copy-link-btn");
    btn.textContent = "✅ Copied!";
    setTimeout(() => { btn.textContent = "📋 Copy link"; }, 2500);
  });
}

// ── Auto-join from ?room=CODE in URL ─────────────────────────────────────────
function checkURLRoom() {
  const room = new URLSearchParams(location.search).get("room");
  if (!room) return;
  document.querySelector("[data-tab='vote']").click();
  document.getElementById("join-code-input").value = room;
  joinSession();
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

["filter-location", "filter-halal", "filter-nonhalal", "filter-baf", "filter-bt", "filter-pkb"]
  .forEach(id => document.getElementById(id).addEventListener("change", applyFilters));

document.getElementById("spin-btn").addEventListener("click", spin);
document.getElementById("create-session-btn").addEventListener("click", createSession);
document.getElementById("join-session-btn").addEventListener("click", joinSession);
document.getElementById("end-session-btn").addEventListener("click", endSession);
document.getElementById("copy-link-btn").addEventListener("click", copyLink);
document.getElementById("join-code-input").addEventListener("keydown", e => {
  if (e.key === "Enter") joinSession();
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadSheet().then(checkURLRoom);
