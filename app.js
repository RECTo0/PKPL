import { firebaseConfig } from "./firebase.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, getDocs, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ===== CONFIG =====
const FIBO = ["0,5","1","2","3","5","8","13","20","40","100","?","☕"];
const ALLOW_EVERYONE_KICK = true;

const FX_DURATION_MS = 6000; // sons + effet “fail/perfect” >= 6s
const SHUFFLE_MS = 900;
const DEAL_STEP_MS = 90;
const FLIP_STEP_MS = 120;
// ==================

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
  round: 1,
  revealLocked: false,
  selected: null,
  unsub: [],
  lastFxRound: null
};

let latestPlayers = [];
let latestVotes = [];

// Helpers
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
function colorForValue(val){
  const hue = hashToHue(String(val));
  return `hsl(${hue} 70% 60% / 0.35)`;
}

// Firestore refs
function roomRef(roomId){ return doc(db, "rooms", roomId); }
function playersCol(roomId){ return collection(db, "rooms", roomId, "players"); }
function votesCol(roomId){ return collection(db, "rooms", roomId, "votes"); }
function playerRef(roomId, playerId){ return doc(db, "rooms", roomId, "players", playerId); }
function voteRef(roomId, playerId){ return doc(db, "rooms", roomId, "votes", playerId); }

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

function setPills(){
  roundPill.textContent = `Round ${state.round || 1}`;
  revealPill.textContent = state.revealLocked ? "Reveal ✅" : "Reveal OFF";
  revealPill.style.borderColor = state.revealLocked ? "rgba(34,197,94,.35)" : "rgba(255,255,255,.14)";
  revealPill.style.background = state.revealLocked ? "rgba(34,197,94,.10)" : "rgba(0,0,0,.22)";
}

// ===== WebAudio (sons originaux, pas de sons copiés) =====
let audioCtx = null;
function ensureAudio(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}
function beep(freq=440, dur=0.08, type="sine", gain=0.05){
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

function joinSound(){
  // jingle entrée
  beep(523.25, 0.08, "sine", 0.05);
  setTimeout(()=>beep(659.25, 0.08, "sine", 0.05), 100);
  setTimeout(()=>beep(783.99, 0.10, "sine", 0.05), 200);
}
function replaySound(){
  // nouvelle manche
  beep(392, 0.10, "triangle", 0.05);
  setTimeout(()=>beep(523.25, 0.10, "triangle", 0.05), 140);
  setTimeout(()=>beep(659.25, 0.12, "triangle", 0.05), 280);
}
function suspenseTick(n){
  beep(420 + (3-n)*110, 0.06, "square", 0.03);
}
function shuffleSound(){
  // riffle léger
  for (let i=0;i<12;i++){
    setTimeout(()=>beep(900 + Math.random()*900, 0.015, "square", 0.010), i*35);
  }
}
function applause6s(){
  // ~6s de claps
  for (let i=0;i<70;i++){
    setTimeout(()=>beep(280+Math.random()*520, 0.03, "triangle", 0.02), i*85);
  }
}
function perfect6s(){
  // motif joyeux répété ~6s
  const seq = [523.25, 659.25, 783.99, 1046.5];
  for(let r=0; r<6; r++){
    seq.forEach((f, i) => setTimeout(()=>beep(f, 0.10, "sine", 0.05), r*950 + i*150));
  }
}
function fail6s(){
  // descente dramatique + buzz jusqu'à ~6s
  const base = [440, 392, 330, 262, 220];
  base.forEach((f, i) => setTimeout(()=>beep(f, 0.18, "sawtooth", 0.04), i*220));
  for(let i=0; i<22; i++){
    setTimeout(()=>beep(120 + Math.random()*40, 0.08, "square", 0.018), 1200 + i*220);
  }
}
// ==============================================

// FX
function fireworks(){
  clearFx();
  const bursts = 5;
  const particlesPerBurst = 24;
  for (let b=0; b<bursts; b++){
    const ox = 18 + Math.random()*64;
    const oy = 18 + Math.random()*55;
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

function ensureDealerDeck(){
  if (fxLayer.querySelector(".dealerDeck")) return;
  const d = document.createElement("div");
  d.className = "dealerDeck";
  fxLayer.appendChild(d);
}
function getRect(el){
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 };
}
function dealerDealToTargets(targetEls){
  ensureDealerDeck();
  const deckEl = fxLayer.querySelector(".dealerDeck");
  if (!deckEl) return;

  const deckPos = getRect(deckEl);

  targetEls.forEach((t, i) => {
    const toPos = getRect(t);
    const fly = document.createElement("div");
    fly.className = "dealFly";
    fly.style.setProperty("--x0", `${deckPos.x - 37}px`);
    fly.style.setProperty("--y0", `${deckPos.y - 49}px`);
    fly.style.setProperty("--x1", `${toPos.x - 37}px`);
    fly.style.setProperty("--y1", `${toPos.y - 49}px`);
    fly.style.animationDelay = `${i * 70}ms`;
    document.body.appendChild(fly);

    setTimeout(() => beep(900 + Math.random()*700, 0.015, "square", 0.010), i*70);

    fly.addEventListener("animationend", () => fly.remove());
  });
}

function showShuffleAnimation(){
  clearFx();
  ensureDealerDeck();
  const deck = document.createElement("div");
  deck.className = "shuffleDeck shuffleRun";
  deck.innerHTML = `<div class="shuffleCard"></div><div class="shuffleCard"></div><div class="shuffleCard"></div>`;
  fxLayer.appendChild(deck);
  shuffleSound();
  setTimeout(() => {
    // on garde le dealerDeck en place, on enlève juste le shuffle
    const sh = fxLayer.querySelector(".shuffleDeck");
    if (sh) sh.remove();
  }, SHUFFLE_MS);
}

// Voting cards
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
      if (state.role !== "player") return; // observateur ne vote pas
      if (state.revealLocked) { toast("Tour terminé"); return; }
      state.selected = v;
      renderCards();
      await castVote(v); // ✅ écrase le vote => on peut changer avant reveal
      toast("Vote OK");
    };
    cardsEl.appendChild(c);
  });
}

async function castVote(value){
  await setDoc(voteRef(state.roomId, state.playerId), { value, updatedAt: serverTimestamp() }, { merge: true });
  await setDoc(playerRef(state.roomId, state.playerId), { hasVoted: true, updatedAt: serverTimestamp() }, { merge: true });
}

// Join (pseudo unique)
async function joinRoom(){
  const name = (nameInput.value || "").trim().slice(0,24);
  if (!name) { alert("Entre un pseudo."); return; }

  let roomId = sanitizeRoomId(roomIdInput.value);
  if (!roomId) roomId = "room-" + Math.random().toString(36).slice(2,8);

  // pseudo unique
  const ps = await getDocs(playersCol(roomId));
  for (const d of ps.docs){
    const p = d.data();
    if ((p.name || "").toLowerCase() === name.toLowerCase()){
      alert("Pseudo déjà utilisé dans cette room. Choisis un autre.");
      return;
    }
  }

  const role = getRole();
  const playerId = uid();

  state.roomId = roomId;
  state.playerId = playerId;
  state.name = name;
  state.role = role;
  state.selected = null;

  const r = roomRef(roomId);
  const snap = await getDoc(r);
  if (!snap.exists()){
    await setDoc(r, {
      createdAt: serverTimestamp(),
      revealLocked: false,
      round: 1,
      countdownActive: false,
      countdownEndsAt: null
    });
    state.round = 1;
  } else {
    state.round = snap.data().round || 1;
  }

  await setDoc(playerRef(roomId, playerId), {
    name, role, hasVoted: false, joinedAt: Date.now()
  }, { merge: true });

  showRoom(roomId);
  bindRoom();

  joinSound();
}

// Kick
async function kickPlayer(targetId){
  if (!ALLOW_EVERYONE_KICK) return;
  if (targetId === state.playerId) return;
  try { await deleteDoc(voteRef(state.roomId, targetId)); } catch {}
  try { await deleteDoc(playerRef(state.roomId, targetId)); } catch {}
  toast("Kick");
}

// Countdown / reveal
function votedPlayersOnly(players){ return players.filter(p => p.role !== "observer"); }
function everyoneVoted(players){
  const voters = votedPlayersOnly(players);
  if (voters.length === 0) return false;
  return voters.every(p => p.hasVoted);
}
function isUnanimous(votes){
  const vals = votes.map(v => String(v.value ?? "—"));
  return vals.length > 0 && new Set(vals).size === 1;
}

function countdownUI(n){
  countdownPill.textContent = String(n);
  countdownPill.classList.remove("hidden");
  suspenseTick(n);
}
function hideCountdownUI(){
  countdownPill.classList.add("hidden");
  countdownPill._last = null;
}

async function startCountdownIfNeeded(){
  if (state.revealLocked) return;
  if (!everyoneVoted(latestPlayers)) return;

  const r = roomRef(state.roomId);
  const snap = await getDoc(r);
  if (!snap.exists()) return;
  const data = snap.data();

  if (data.countdownActive || data.revealLocked) return;

  const endsAt = Date.now() + 3200; // 3..2..1
  await updateDoc(r, { countdownActive: true, countdownEndsAt: endsAt });
}

async function doRevealNow(){
  const r = roomRef(state.roomId);
  const snap = await getDoc(r);
  if (!snap.exists()) return;
  const data = snap.data();
  if (data.revealLocked) return;

  await updateDoc(r, {
    revealLocked: true,
    countdownActive: false,
    countdownEndsAt: null
  });
}

async function revealPressed(){
  ensureAudio();
  await doRevealNow(); // reveal une seule fois (pas de hide)
}

async function replayPressed(){
  ensureAudio();
  replaySound();

  // delete votes
  const vs = await getDocs(votesCol(state.roomId));
  for (const v of vs.docs) await deleteDoc(v.ref);

  // reset players hasVoted
  const ps = await getDocs(playersCol(state.roomId));
  for (const p of ps.docs){
    await updateDoc(p.ref, { hasVoted: false });
  }

  // next round + unlock
  const rSnap = await getDoc(roomRef(state.roomId));
  const nextRound = (rSnap.exists() ? (rSnap.data().round || 1) : 1) + 1;

  await updateDoc(roomRef(state.roomId), {
    revealLocked: false,
    round: nextRound,
    countdownActive: false,
    countdownEndsAt: null
  });

  // local reset
  state.selected = null;
  renderCards();
  latestVotes = [];
  resultsEl.textContent = "En attente…";
  clearFx();
  hideCountdownUI();
  state.lastFxRound = null;
  toast("Nouveau tour");
}

// Render results (Blackjack + Dealer deal)
async function renderResultsBlackjack(votes){
  const nameById = new Map(latestPlayers.map(p => [p.id, p.name || p.id]));

  // duplicates color
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
    const dup = (counts.get(key) || 0) >= 2;

    const card = document.createElement("div");
    card.className = "votecard deal faceDown";
    card.style.animationDelay = `${idx * DEAL_STEP_MS}ms`;

    if (dup){
      card.style.background = colorForValue(key);
      card.style.borderColor = "rgba(255,255,255,.22)";
    }

    const inner = document.createElement("div");
    inner.className = "inner";

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

  const cards = [...wrap.querySelectorAll(".votecard")];

  // Dealer deal fly
  setTimeout(() => dealerDealToTargets(cards), 50);

  // Flip sequential blackjack
  cards.forEach((c, i) => {
    setTimeout(() => {
      c.classList.remove("faceDown");
      c.classList.add("flip");
      beep(700 + i*18, 0.03, "square", 0.01);
    }, SHUFFLE_MS + 450 + i*FLIP_STEP_MS);
  });
}

function showUnicorn(){
  resultsEl.innerHTML = `<div class="unicorn">🦄 <span>Pas d’accord ? La licorne exige un débat civilisé.</span></div>`;
}

// Bind
function renderPlayers(){
  playersList.innerHTML = "";
  latestPlayers
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

      const canKick = ALLOW_EVERYONE_KICK && (p.id !== state.playerId);
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

  whoami.textContent = `${state.name} • ${state.role === "observer" ? "Observateur" : "Joueur"}`;
  roomStatus.textContent = "";

  // room
  state.unsub.push(onSnapshot(roomRef(state.roomId), async (d) => {
    if (!d.exists()) return;
    const data = d.data();

    state.round = data.round || 1;
    state.revealLocked = !!data.revealLocked;
    setPills();

    // reveal locked => disable reveal, no hide
    revealBtn.disabled = state.revealLocked;
    revealBtn.textContent = state.revealLocked ? "Reveal ✅" : "Reveal";

    // countdown
    if (data.countdownActive && data.countdownEndsAt){
      const remaining = Math.max(0, data.countdownEndsAt - Date.now());
      const n = Math.ceil(remaining / 1000);
      const shown = Math.min(3, Math.max(1, n));
      if (countdownPill._last !== shown){
        countdownPill._last = shown;
        countdownUI(shown);
      }
      if (remaining <= 0){
        hideCountdownUI();
        await doRevealNow();
      }
    } else {
      hideCountdownUI();
    }

    // round unlocked => reset UI locally
    if (!state.revealLocked){
      state.selected = null;
      renderCards();
      clearFx();
      resultsEl.textContent = "En attente…";
      state.lastFxRound = null;
      return;
    }

    // reveal => FX once per round
    if (state.revealLocked && state.lastFxRound !== state.round){
      state.lastFxRound = state.round;

      // keep only voters (exclude observers)
      const voterIds = new Set(latestPlayers.filter(p => p.role !== "observer").map(p => p.id));
      const voterVotes = latestVotes.filter(v => voterIds.has(v.id));

      showShuffleAnimation();

      if (isUnanimous(voterVotes)){
        perfect6s();
        applause6s();
        setTimeout(() => fireworks(), 220);
        setTimeout(async () => {
          await renderResultsBlackjack(voterVotes);
        }, 60);
      } else {
        showUnicorn();
        fail6s();
        setTimeout(async () => {
          await renderResultsBlackjack(voterVotes);
        }, FX_DURATION_MS);
      }
    }
  }));

  // players
  state.unsub.push(onSnapshot(playersCol(state.roomId), (qs) => {
    const players = [];
    qs.forEach(docu => players.push({ id: docu.id, ...docu.data() }));
    latestPlayers = players;
    renderPlayers();
    startCountdownIfNeeded();
  }));

  // votes
  state.unsub.push(onSnapshot(votesCol(state.roomId), (qs) => {
    const votes = [];
    qs.forEach(docu => votes.push({ id: docu.id, ...docu.data() }));
    latestVotes = votes;
  }));
}

// Leave
async function leave(){
  try{ await deleteDoc(playerRef(state.roomId, state.playerId)); } catch {}
  try{ await deleteDoc(voteRef(state.roomId, state.playerId)); } catch {}
  clearUnsubs();
  latestPlayers = [];
  latestVotes = [];
  clearFx();
  state = {
    roomId:null, playerId:null, name:null, role:null,
    round:1, revealLocked:false, selected:null, unsub:[], lastFxRound:null
  };
  showJoin();
}

// Events
joinBtn.onclick = joinRoom;
revealBtn.onclick = revealPressed;
replayBtn.onclick = replayPressed;
leaveBtn.onclick = leave;

// URL ?room=
const params = new URLSearchParams(location.search);
const roomFromUrl = sanitizeRoomId(params.get("room"));
if (roomFromUrl) roomIdInput.value = roomFromUrl;

// unlock audio on first interaction (mobile/Chrome)
window.addEventListener("pointerdown", () => { try{ ensureAudio(); }catch{} }, { once:true });
