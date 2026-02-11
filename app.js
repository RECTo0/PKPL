import { firebaseConfig } from "./firebase.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, getDocs, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ====== CONFIG ======
const FIBO = ["0","1","2","3","5","8","13","20","40","100","?","☕"];
const ALLOW_EVERYONE_KICK = true;

// présence
const HEARTBEAT_MS = 10_000;
const OFFLINE_AFTER_MS = 25_000;

// FX durée
const FX_DURATION_MS = 4000;
// =====================

// UI
const joinView = document.getElementById("joinView");
const roomView = document.getElementById("roomView");
const roomHint = document.getElementById("roomHint");

const roomIdInput = document.getElementById("roomIdInput");
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");

const roomTitle = document.getElementById("roomTitle");
const roomStatus = document.getElementById("roomStatus");
const roundPill = document.getElementById("roundPill");
const revealPill = document.getElementById("revealPill");
const countdownPill = document.getElementById("countdownPill");
const whoami = document.getElementById("whoami");

const playersList = document.getElementById("playersList");
const cardsEl = document.getElementById("cards");
const resultsEl = document.getElementById("results");
const voteHint = document.getElementById("voteHint");
const resultHint = document.getElementById("resultHint");

const revealBtn = document.getElementById("revealBtn");
const replayBtn = document.getElementById("replayBtn");
const leaveBtn = document.getElementById("leaveBtn");

const fxLayer = document.getElementById("fxLayer");
const toastEl = document.getElementById("toast");

let state = {
  roomId: null,
  playerId: null,
  name: null,
  role: null, // player | observer
  isFacilitator: false, // on garde pour “Rejouer” (reset)
  facilitatorId: null,

  revealed: false,
  revealLocked: false,
  round: 1,

  selected: null,
  unsub: [],
  heartbeatTimer: null,

  lastRoundRendered: null, // pour éviter multi-fx
};

let latestVotes = [];
let latestPlayers = [];

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}
function sanitizeRoomId(s) {
  return (s || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 40);
}
function getRole() {
  return document.querySelector('input[name="role"]:checked')?.value || "player";
}
function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 1400);
}
function initials(name){
  const n = (name || "?").trim();
  const parts = n.split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || "?";
  const b = parts[1]?.[0] || "";
  return (a + b).toUpperCase();
}
function hashToHue(str){
  let h = 0;
  for (let i=0; i<str.length; i++) h = (h*31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}
function avatarStyle(name){
  const hue = hashToHue(String(name || ""));
  return {
    bg: `hsl(${hue} 70% 45% / .22)`,
    border: `hsl(${hue} 70% 60% / .35)`
  };
}

// Colors for duplicated vote values
function colorForValue(val){
  const hue = hashToHue(String(val));
  return `hsl(${hue} 70% 60% / 0.35)`;
}

// Firestore refs
function roomRef(roomId){ return doc(db, "rooms", roomId); }
function playersCol(roomId){ return collection(db, "rooms", roomId, "players"); }
function votesCol(roomId){ return collection(db, "rooms", roomId, "votes"); }
function statsCol(roomId){ return collection(db, "rooms", roomId, "stats"); }

function playerRef(roomId, playerId){ return doc(db, "rooms", roomId, "players", playerId); }
function voteRef(roomId, playerId){ return doc(db, "rooms", roomId, "votes", playerId); }
function statRef(roomId, playerId){ return doc(db, "rooms", roomId, "stats", playerId); }

// View
function showRoom(roomId){
  joinView.classList.add("hidden");
  roomView.classList.remove("hidden");
  roomHint.textContent = `Room: ${roomId}`;
  roomTitle.textContent = `Room: ${roomId}`;
}
function showJoin(){
  roomView.classList.add("hidden");
  joinView.classList.remove("hidden");
  roomHint.textContent = "";
}
function clearUnsubs(){
  state.unsub.forEach(fn => { try{ fn(); }catch{} });
  state.unsub = [];
}
function clearFx(){ fxLayer.innerHTML = ""; }

// ===== WebAudio (no copyrighted sounds) =====
let audioCtx = null;
function ensureAudio(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}
function beep(freq=440, dur=0.09, type="sine", gain=0.05){
  ensureAudio();
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(audioCtx.destination);
  o.start(t); o.stop(t + dur);
}
function drumroll(duration=0.9){
  ensureAudio();
  const t = audioCtx.currentTime;
  const bufferSize = 2 * audioCtx.sampleRate;
  const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const output = noiseBuffer.getChannelData(0);
  for (let i=0; i<bufferSize; i++) output[i] = Math.random()*2 - 1;

  const noise = audioCtx.createBufferSource();
  noise.buffer = noiseBuffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 900;

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.08, t + 0.15);
  g.gain.exponentialRampToValueAtTime(0.02, t + duration);

  noise.connect(filter); filter.connect(g); g.connect(audioCtx.destination);
  noise.start(t);
  noise.stop(t + duration);
}
function applause(duration=1.1){
  // noise “claps” rapides
  ensureAudio();
  const t0 = audioCtx.currentTime;
  for (let i=0; i<18; i++){
    const dt = i * (duration/18);
    const freq = 400 + Math.random()*300;
    beep(freq, 0.03, "triangle", 0.03);
    setTimeout(() => beep(freq+80, 0.03, "triangle", 0.02), (dt*1000)+30);
  }
}
function perfectSound(){
  // montée joyeuse
  beep(523.25, 0.10, "sine", 0.05);
  setTimeout(() => beep(659.25, 0.10, "sine", 0.05), 120);
  setTimeout(() => beep(783.99, 0.12, "sine", 0.06), 240);
}
function gameOverSound(){
  // descente dramatique (style “fail”, mais original)
  const notes = [440, 392, 330, 262];
  notes.forEach((f, i) => setTimeout(() => beep(f, 0.16, "sawtooth", 0.04), i*170));
}

// ===== FX =====
function fireworks(){
  clearFx();
  const bursts = 5;
  const particlesPerBurst = 24;
  for (let b=0; b<bursts; b++){
    const ox = 18 + Math.random()*64; // %
    const oy = 18 + Math.random()*55; // %
    for (let i=0; i<particlesPerBurst; i++){
      const p = document.createElement("div");
      p.className = "particle";
      const angle = (Math.PI*2) * (i/particlesPerBurst);
      const dist = 50 + Math.random()*110;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const hue = Math.floor(Math.random()*360);
      p.style.left = `${ox}%`;
      p.style.top = `${oy}%`;
      p.style.background = `hsl(${hue} 80% 60%)`;
      p.style.setProperty("--dx", `${dx}px`);
      p.style.setProperty("--dy", `${dy}px`);
      fxLayer.appendChild(p);
    }
  }
  setTimeout(clearFx, 1200);
}

// ===== Cards UI =====
function renderCards(){
  cardsEl.innerHTML = "";
  FIBO.forEach(v => {
    const c = document.createElement("div");
    c.className = "pcard" + (state.selected === v ? " selected" : "");
    c.innerHTML = `
      <div class="mini">${v}</div>
      <div class="v">${v}</div>
      <div class="mini r">${v}</div>
    `;
    c.onclick = async () => {
      if (state.role !== "player") return;
      if (state.revealLocked) { toast("Tour verrouillé"); return; }
      state.selected = v;
      renderCards();
      await castVote(v);
      toast("Vote OK");
    };
    cardsEl.appendChild(c);
  });
}

async function castVote(value){
  await setDoc(voteRef(state.roomId, state.playerId), { value, updatedAt: serverTimestamp() }, { merge: true });
  await setDoc(playerRef(state.roomId, state.playerId), { hasVoted: true, updatedAt: serverTimestamp() }, { merge: true });
}

// ===== Presence heartbeat =====
async function heartbeat(){
  if (!state.roomId || !state.playerId) return;
  await setDoc(playerRef(state.roomId, state.playerId), { lastSeen: Date.now() }, { merge: true });
}
function startHeartbeat(){
  stopHeartbeat();
  heartbeat(); // now
  state.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
}
function stopHeartbeat(){
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

// ===== Join with unique name =====
async function joinRoom(){
  const name = (nameInput.value || "").trim().slice(0,24);
  if (!name) { alert("Entre un pseudo."); return; }

  let roomId = sanitizeRoomId(roomIdInput.value);
  if (!roomId) roomId = "room-" + Math.random().toString(36).slice(2,8);

  const role = getRole();
  const playerId = uid();

  // Check unique pseudo (among active players)
  const ps = await getDocs(playersCol(roomId));
  const now = Date.now();
  for (const d of ps.docs){
    const p = d.data();
    const alive = (p.lastSeen && (now - p.lastSeen) < OFFLINE_AFTER_MS);
    if (alive && (p.name || "").toLowerCase() === name.toLowerCase()){
      alert("Ce pseudo est déjà utilisé dans cette room. Choisis un autre.");
      return;
    }
  }

  state.roomId = roomId;
  state.playerId = playerId;
  state.name = name;
  state.role = role;
  state.selected = null;

  // Create room if needed
  const r = roomRef(roomId);
  const snap = await getDoc(r);

  if (!snap.exists()){
    await setDoc(r, {
      createdAt: serverTimestamp(),
      revealed: false,
      revealLocked: false,
      revealBy: null,
      revealAt: null,
      facilitatorId: playerId,
      round: 1,
      countdownActive: false,
      countdownEndsAt: null
    });
    state.isFacilitator = true;
    state.facilitatorId = playerId;
    state.round = 1;
  } else {
    const data = snap.data();
    state.facilitatorId = data.facilitatorId;
    state.isFacilitator = data.facilitatorId === playerId;
    state.round = data.round || 1;
  }

  await setDoc(playerRef(roomId, playerId), {
    name,
    role,
    hasVoted: false,
    lastSeen: Date.now()
  }, { merge: true });

  showRoom(roomId);
  startHeartbeat();
  bindRoom();
}

async function kickPlayer(targetId){
  if (!ALLOW_EVERYONE_KICK && !state.isFacilitator) return;
  if (targetId === state.playerId) return;
  try { await deleteDoc(voteRef(state.roomId, targetId)); } catch {}
  try { await deleteDoc(playerRef(state.roomId, targetId)); } catch {}
  toast("Kick");
}

// ===== Round / Reveal logic =====
function setPills(){
  roundPill.textContent = `Round ${state.round || 1}`;
  revealPill.textContent = state.revealed ? "Reveal ON" : "Reveal OFF";
  revealPill.style.borderColor = state.revealed ? "rgba(34,197,94,.35)" : "rgba(255,255,255,.14)";
  revealPill.style.background = state.revealed ? "rgba(34,197,94,.10)" : "rgba(0,0,0,.18)";
}

function activePlayersOnly(players){
  const now = Date.now();
  return players.filter(p => p.lastSeen && (now - p.lastSeen) < OFFLINE_AFTER_MS);
}

function votedPlayersOnly(players){
  return players.filter(p => p.role !== "observer");
}

function everyoneVoted(players){
  const voters = votedPlayersOnly(players);
  if (voters.length === 0) return false;
  return voters.every(p => p.hasVoted);
}

function countdownUI(n){
  countdownPill.textContent = String(n);
  countdownPill.classList.remove("hidden");
}
function hideCountdownUI(){
  countdownPill.classList.add("hidden");
}

async function startCountdownIfNeeded(){
  // trigger only when all voted and reveal not yet locked
  if (state.revealLocked) return;

  const active = activePlayersOnly(latestPlayers);
  if (!everyoneVoted(active)) return;

  const r = roomRef(state.roomId);
  const snap = await getDoc(r);
  if (!snap.exists()) return;
  const data = snap.data();

  if (data.countdownActive || data.revealLocked) return;

  // start a 3s countdown for everyone
  const endsAt = Date.now() + 3200;
  await updateDoc(r, { countdownActive: true, countdownEndsAt: endsAt });
}

async function doRevealNow(triggeredBy){
  const r = roomRef(state.roomId);
  const snap = await getDoc(r);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.revealLocked) return; // already revealed once

  await updateDoc(r, {
    revealed: true,
    revealLocked: true,
    revealBy: triggeredBy || null,
    revealAt: Date.now(),
    countdownActive: false,
    countdownEndsAt: null
  });
}

// button reveal: immediate reveal (but no hide)
async function revealPressed(){
  ensureAudio();
  await doRevealNow(state.playerId);
}

// replay: new round (facilitator only, sinon trop chaos)
async function replay(){
  if (!state.isFacilitator){
    toast("Rejouer: facilitateur");
    return;
  }

  // delete votes
  const vs = await getDocs(votesCol(state.roomId));
  for (const v of vs.docs) await deleteDoc(v.ref);

  // reset players hasVoted
  const ps = await getDocs(playersCol(state.roomId));
  for (const p of ps.docs) {
    await updateDoc(p.ref, { hasVoted: false });
  }

  // next round + unlock
  const rSnap = await getDoc(roomRef(state.roomId));
  const nextRound = (rSnap.exists() ? (rSnap.data().round || 1) : 1) + 1;

  await updateDoc(roomRef(state.roomId), {
    revealed: false,
    revealLocked: false,
    revealBy: null,
    revealAt: null,
    countdownActive: false,
    countdownEndsAt: null,
    round: nextRound
  });

  // local reset
  state.selected = null;
  renderCards();
  latestVotes = [];
  resultsEl.textContent = "En attente…";
  clearFx();
  hideCountdownUI();
  toast("Nouveau tour");
}

// ===== Stats badges =====
function parseVoteToNumber(v){
  // keep numeric only (ignore ? and ☕)
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function median(nums){
  const a = [...nums].sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}

async function updateStatsIfFacilitator(votes, players){
  if (!state.isFacilitator) return;

  const active = activePlayersOnly(players);
  const voterIds = active.filter(p => p.role !== "observer").map(p => p.id);

  // map id->value
  const byId = new Map(votes.map(v => [v.id, v.value]));
  const numericVotes = [];
  const numericById = new Map();

  for (const id of voterIds){
    const val = byId.get(id);
    const n = parseVoteToNumber(val);
    if (n !== null){
      numericVotes.push(n);
      numericById.set(id, n);
    }
  }
  if (numericVotes.length === 0) return;

  const med = median(numericVotes);

  // closest-to-median = “Zen” point
  let bestDiff = Infinity;
  const diffs = new Map();
  for (const [id, n] of numericById.entries()){
    const d = Math.abs(n - med);
    diffs.set(id, d);
    if (d < bestDiff) bestDiff = d;
  }
  const zenWinners = [...diffs.entries()].filter(([,d])=>d===bestDiff).map(([id])=>id);

  // update aggregates
  for (const id of voterIds){
    const sref = statRef(state.roomId, id);
    const snap = await getDoc(sref);
    const cur = snap.exists() ? snap.data() : { rounds: 0, sum: 0, zen: 0 };

    const n = numericById.get(id);
    const addSum = (n !== undefined) ? n : 0;

    await setDoc(sref, {
      rounds: (cur.rounds || 0) + 1,
      sum: (cur.sum || 0) + addSum,
      zen: (cur.zen || 0) + (zenWinners.includes(id) ? 1 : 0),
      updatedAt: Date.now()
    }, { merge: true });
  }
}

async function computeBadges(players){
  const active = activePlayersOnly(players).filter(p => p.role !== "observer");
  const snaps = await getDocs(statsCol(state.roomId));
  const stats = new Map();
  snaps.forEach(d => stats.set(d.id, d.data()));

  let zenBest = -1, zenId = null;
  let lowBest = Infinity, lowId = null;

  for (const p of active){
    const s = stats.get(p.id);
    if (!s || !(s.rounds>0)) continue;
    const zen = s.zen || 0;
    const avg = (s.sum || 0) / (s.rounds || 1);

    if (zen > zenBest){ zenBest = zen; zenId = p.id; }
    if (avg < lowBest){ lowBest = avg; lowId = p.id; }
  }

  return { zenId, lowId };
}

// ===== Results render + FX logic =====
async function renderResultsFromVotes(votes){
  if (!state.revealLocked) return;

  // build name map
  const active = activePlayersOnly(latestPlayers);
  const nameById = new Map(active.map(p => [p.id, p.name || p.id]));

  // counts for duplicate coloring
  const counts = new Map();
  for (const v of votes){
    const key = String(v.value ?? "—");
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const sorted = [...votes].sort((a,b) =>
    String(nameById.get(a.id) || a.id).localeCompare(String(nameById.get(b.id) || b.id))
  );

  const wrap = document.createElement("div");
  wrap.className = "votecards";

  sorted.forEach((v, idx) => {
    const val = v.value ?? "—";
    const key = String(val);
    const n = counts.get(key) || 0;

    const card = document.createElement("div");
    card.className = "votecard deal";
    card.style.animationDelay = `${idx*55}ms`;

    if (n >= 2){
      card.style.background = colorForValue(key);
      card.style.borderColor = "rgba(255,255,255,.22)";
    }

    const inner = document.createElement("div");
    inner.className = "inner";
    inner.style.animationDelay = `${120 + idx*55}ms`;

    const back = document.createElement("div");
    back.className = "face back";
    back.textContent = "🂠";

    const front = document.createElement("div");
    front.className = "face front";
    front.textContent = val;

    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = nameById.get(v.id) || v.id;

    inner.appendChild(back);
    inner.appendChild(front);
    card.appendChild(inner);
    card.appendChild(nm);
    wrap.appendChild(card);
  });

  resultsEl.innerHTML = "";
  resultsEl.appendChild(wrap);
}

function onlyVoterVotes(votes, players){
  const voterIds = new Set(players.filter(p => p.role !== "observer").map(p => p.id));
  return votes.filter(v => voterIds.has(v.id));
}

function isUnanimous(votes){
  const vals = votes.map(v => String(v.value ?? "—"));
  if (vals.length === 0) return false;
  return new Set(vals).size === 1;
}

function showUnicorn(){
  resultsEl.innerHTML = `<div class="unicorn">🦄 <span>Désaccord détecté… la licorne réclame une discussion.</span></div>`;
}

async function handleRevealOnce(){
  // prevent replaying fx for same round
  if (state.lastRoundRendered === state.round) return;
  state.lastRoundRendered = state.round;

  const active = activePlayersOnly(latestPlayers);
  const voterVotes = onlyVoterVotes(latestVotes, active);

  // update stats (facilitator) once reveal happens
  await updateStatsIfFacilitator(voterVotes, active);

  // badges compute
  const badges = await computeBadges(active);

  // update participant badges in UI rendering (stored in state)
  state._badges = badges;

  // all voted same?
  if (isUnanimous(voterVotes)){
    fireworks();
    perfectSound();
    applause();
    // show results immediately (and keep fx feeling)
    await renderResultsFromVotes(voterVotes);
    setTimeout(() => {}, FX_DURATION_MS);
  } else {
    // show unicorn + game over sound for 4s, then results
    showUnicorn();
    gameOverSound();
    setTimeout(async () => {
      await renderResultsFromVotes(voterVotes);
    }, FX_DURATION_MS);
  }
}

// ===== Bind room listeners =====
function renderPlayers(){
  const now = Date.now();
  const active = latestPlayers.filter(p => p.lastSeen && (now - p.lastSeen) < OFFLINE_AFTER_MS);
  const badges = state._badges || { zenId: null, lowId: null };

  playersList.innerHTML = "";
  active
    .sort((a,b) => (a.name||"").localeCompare(b.name||""))
    .forEach(p => {
      const li = document.createElement("li");
      li.className = "player";

      const left = document.createElement("div");
      left.className = "pLeft";

      const av = document.createElement("div");
      av.className = "avatar";
      const st = avatarStyle(p.name);
      av.style.background = st.bg;
      av.style.borderColor = st.border;
      av.textContent = initials(p.name);

      const nm = document.createElement("div");
      nm.className = "pName";
      nm.textContent = p.name || "—";

      left.appendChild(av);
      left.appendChild(nm);

      const tags = document.createElement("div");
      tags.className = "tags";

      const roleTag = document.createElement("span");
      roleTag.className = "tag";
      roleTag.textContent = p.role === "observer" ? "👀" : "🎯";
      tags.appendChild(roleTag);

      if (p.role !== "observer"){
        const voteTag = document.createElement("span");
        voteTag.className = "tag " + (p.hasVoted ? "ok" : "");
        voteTag.textContent = p.hasVoted ? "✅" : "…";
        tags.appendChild(voteTag);
      }

      // badges fun
      if (p.id === badges.zenId){
        const z = document.createElement("span");
        z.className = "tag";
        z.textContent = "🧘 Estimateur Zen";
        tags.appendChild(z);
      }
      if (p.id === badges.lowId){
        const l = document.createElement("span");
        l.className = "tag";
        l.textContent = "⬇️ Toujours plus bas";
        tags.appendChild(l);
      }

      const canKick = (ALLOW_EVERYONE_KICK || state.isFacilitator) && (p.id !== state.playerId);
      if (canKick){
        const kb = document.createElement("button");
        kb.className = "kick";
        kb.textContent = "Kick";
        kb.onclick = () => kickPlayer(p.id);
        tags.appendChild(kb);
      }

      li.appendChild(left);
      li.appendChild(tags);
      playersList.appendChild(li);
    });
}

function bindRoom(){
  clearUnsubs();
  renderCards();

  voteHint.textContent = "";
  resultHint.textContent = "";

  whoami.textContent = `${state.name} • ${state.role === "observer" ? "Observateur" : "Joueur"}`;

  // Room state
  state.unsub.push(onSnapshot(roomRef(state.roomId), async (d) => {
    if (!d.exists()) return;
    const data = d.data();

    state.round = data.round || 1;
    state.facilitatorId = data.facilitatorId;

    state.revealed = !!data.revealed;
    state.revealLocked = !!data.revealLocked;

    setPills();

    // Reveal button behavior: once locked => disabled (no hide)
    revealBtn.disabled = state.revealLocked;
    revealBtn.textContent = state.revealLocked ? "Reveal ✅" : "Reveal";

    // Rejouer visible, mais action = facilitateur
    replayBtn.disabled = !state.isFacilitator;

    // countdown display
    if (data.countdownActive && data.countdownEndsAt){
      const remaining = Math.max(0, data.countdownEndsAt - Date.now());
      const n = Math.ceil(remaining / 1000);
      countdownUI(Math.min(3, Math.max(1, n)));
      // suspense sounds when countdown is active
      // (avoid spamming: tick only when number changes)
      if (countdownPill._last !== n){
        countdownPill._last = n;
        drumroll(0.18);
        beep(440 + (3-n)*90, 0.06, "square", 0.03);
      }
      if (remaining <= 0){
        hideCountdownUI();
        // auto reveal at end
        await doRevealNow(null);
      }
    } else {
      hideCountdownUI();
    }

    // On new round / unlocked, clear selection everywhere
    if (!state.revealLocked){
      state.selected = null;
      renderCards();
      clearFx();
      resultsEl.textContent = "En attente…";
      state.lastRoundRendered = null;
    }

    // When reveal happens: run fx once
    if (state.revealLocked){
      await handleRevealOnce();
    }
  }));

  // Players
  state.unsub.push(onSnapshot(playersCol(state.roomId), (qs) => {
    const players = [];
    qs.forEach(docu => players.push({ id: docu.id, ...docu.data() }));
    latestPlayers = players;
    renderPlayers();

    // start countdown automatically when everyone voted (observers excluded)
    startCountdownIfNeeded();
  }));

  // Votes
  state.unsub.push(onSnapshot(votesCol(state.roomId), (qs) => {
    const votes = [];
    qs.forEach(docu => votes.push({ id: docu.id, ...docu.data() }));
    latestVotes = votes;

    // If everyone voted, we can auto-countdown (handled via players snapshot)
  }));
}

// ===== Buttons =====
async function leave(){
  stopHeartbeat();
  try{ await deleteDoc(playerRef(state.roomId, state.playerId)); } catch {}
  try{ await deleteDoc(voteRef(state.roomId, state.playerId)); } catch {}
  clearUnsubs();
  latestVotes = [];
  latestPlayers = [];
  clearFx();
  state = { ...state, roomId:null, playerId:null, name:null, role:null, isFacilitator:false, facilitatorId:null,
           revealed:false, revealLocked:false, round:1, selected:null, unsub:[], heartbeatTimer:null, lastRoundRendered:null };
  showJoin();
}

joinBtn.onclick = joinRoom;
revealBtn.onclick = revealPressed;
replayBtn.onclick = replay;
leaveBtn.onclick = leave;

// URL ?room=
const params = new URLSearchParams(location.search);
const roomFromUrl = sanitizeRoomId(params.get("room"));
if (roomFromUrl) roomIdInput.value = roomFromUrl;

// unlock audio on first interaction
window.addEventListener("pointerdown", () => { try{ ensureAudio(); }catch{} }, { once:true });
