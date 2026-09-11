import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, setDoc,
  onSnapshot, query, where, orderBy, limit, getDocs
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js";

// Public web config -- safe to ship client-side; Firebase's access model is
// enforced by Firestore/Storage security rules, not by hiding this object.
const firebaseConfig = {
  apiKey: "AIzaSyBTF3kv2gV6GD0ODXlbcl-pKPCEBUXu9tM",
  authDomain: "the-monthly-table.firebaseapp.com",
  projectId: "the-monthly-table",
  storageBucket: "the-monthly-table.firebasestorage.app",
  messagingSenderId: "510176592929",
  appId: "1:510176592929:web:b1c7c9eb87f0f596d84f60",
  measurementId: "G-XFHNZ4FEQL"
};

const CATS = {
  'Food Distribution': 'chile',
  'Volunteer Day': 'sage',
  'Community Meal': 'gold',
  'Wellness & Care': 'turquoise',
  'Supply Drive': 'sage'
};
const CAT_LIST = Object.keys(CATS);
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const ADMIN_HASH = 'c5d0d54618459ed1fe7bdababa89c95a0b1f25199901447cca8e9e9b37cd495b';
const SUBMIT_COOLDOWN_MS = 45000;

function pad(n){ return String(n).padStart(2,'0'); }
function todayISO(){
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}
function parseISO(iso){
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y, m-1, d);
}
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function slugify(s){
  return String(s || 'event').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,40) || 'event';
}
async function sha256Hex(text){
  const enc = new TextEncoder().encode(String(text));
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
function getVisitorId(){
  try{
    let id = localStorage.getItem('mt_visitor_id');
    if (!id){
      id = (crypto.randomUUID ? crypto.randomUUID() : ('v-' + Math.random().toString(36).slice(2) + Date.now().toString(36)));
      localStorage.setItem('mt_visitor_id', id);
    }
    return id;
  } catch(e){
    window.__mtVisitorFallback = window.__mtVisitorFallback || ('v-' + Math.random().toString(36).slice(2));
    return window.__mtVisitorFallback;
  }
}

// ---- calendar link builders ----
function buildGoogleCalUrl(e){
  const [y,m,d] = e.date.split('-').map(Number);
  let datesParam, ctz = '';
  if (e.startTime){
    const [sh,sm] = e.startTime.split(':').map(Number);
    let eh = sh + 1, em = sm;
    if (e.endTime){ [eh,em] = e.endTime.split(':').map(Number); }
    datesParam = `${y}${pad(m)}${pad(d)}T${pad(sh)}${pad(sm)}00/${y}${pad(m)}${pad(d)}T${pad(eh)}${pad(em)}00`;
    ctz = '&ctz=America%2FDenver';
  } else {
    const end = new Date(y, m-1, d+1);
    datesParam = `${y}${pad(m)}${pad(d)}/${end.getFullYear()}${pad(end.getMonth()+1)}${pad(end.getDate())}`;
  }
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title || 'Community event',
    dates: datesParam,
    details: e.description || '',
    location: e.location || ''
  });
  return `https://www.google.com/calendar/render?${params.toString()}${ctz}`;
}
function buildICS(e){
  const [y,m,d] = e.date.split('-').map(Number);
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  let startLine, endLine;
  if (e.startTime){
    const [sh,sm] = e.startTime.split(':').map(Number);
    let eh = sh + 1, em = sm;
    if (e.endTime){ [eh,em] = e.endTime.split(':').map(Number); }
    startLine = `DTSTART;TZID=America/Denver:${y}${pad(m)}${pad(d)}T${pad(sh)}${pad(sm)}00`;
    endLine = `DTEND;TZID=America/Denver:${y}${pad(m)}${pad(d)}T${pad(eh)}${pad(em)}00`;
  } else {
    const end = new Date(y, m-1, d+1);
    startLine = `DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`;
    endLine = `DTEND;VALUE=DATE:${end.getFullYear()}${pad(end.getMonth()+1)}${pad(end.getDate())}`;
  }
  const esc = s => String(s || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//The Monthly Table//EN','CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${e.id}@themonthlytable.app`,
    `DTSTAMP:${dtstamp}`,
    startLine, endLine,
    `SUMMARY:${esc(e.title)}`,
    `DESCRIPTION:${esc(e.description + (e.time ? ' (Time: ' + e.time + ')' : ''))}`,
    `LOCATION:${esc(e.location)}`,
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
}
function downloadIcs(e){
  const blob = new Blob([buildICS(e)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = slugify(e.title) + '.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- chips ----
let activeFilter = 'All';
const chipsEl = document.getElementById('chips');
function renderChips(){
  const cats = ['All', ...CAT_LIST];
  chipsEl.innerHTML = cats.map(c =>
    `<button class="chip" data-cat="${escapeHtml(c)}" aria-pressed="${c===activeFilter}">${escapeHtml(c)}</button>`
  ).join('');
  chipsEl.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.cat;
      renderChips();
      renderEvents();
    });
  });
}
renderChips();

let allEvents = [];
const rsvpCache = {};   // id -> { count, isIn, loaded }
const uiState = {};     // id -> { open, unlocked, error, confirmingDelete }
let firestore = null;
let storageService = null;
let adminUnlocked = false;

function vol0(e){ return Number(e.volunteersNeeded) || 0; }

function editPanelHTML(e, ui){
  const id = e.id;
  if (ui.confirmingDelete){
    return `
      <div class="manage-panel">
        <span class="manage-err">Remove this listing for everyone? This can't be undone.</span>
        <div class="manage-actions">
          <button type="button" class="btn danger" data-action="confirm-cancel" data-id="${id}">Yes, remove it</button>
          <button type="button" class="btn subtle" data-action="deny-cancel" data-id="${id}">No, keep it</button>
        </div>
      </div>`;
  }
  const catOptions = CAT_LIST.map(c => `<option value="${escapeHtml(c)}" ${c===e.category?'selected':''}>${escapeHtml(c)}</option>`).join('');
  return `
    <div class="manage-panel">
      <div class="field"><label>Event name</label><input type="text" id="edit-title-${id}" value="${escapeHtml(e.title)}" maxlength="80"></div>
      <div class="row">
        <div class="field"><label>Category</label><select id="edit-category-${id}">${catOptions}</select></div>
        <div class="field"><label>Date</label><input type="date" id="edit-date-${id}" value="${escapeHtml(e.date)}"></div>
      </div>
      <div class="field"><label>Time</label><input type="text" id="edit-time-${id}" value="${escapeHtml(e.time)}" maxlength="40"></div>
      <div class="row">
        <div class="field"><label>Start (optional)</label><input type="time" id="edit-start-${id}" value="${escapeHtml(e.startTime||'')}"></div>
        <div class="field"><label>End (optional)</label><input type="time" id="edit-end-${id}" value="${escapeHtml(e.endTime||'')}"></div>
      </div>
      <div class="field"><label>Location</label><input type="text" id="edit-location-${id}" value="${escapeHtml(e.location)}" maxlength="100"></div>
      <div class="row">
        <div class="field"><label>Your name</label><input type="text" id="edit-host-${id}" value="${escapeHtml(e.hostName)}" maxlength="60"></div>
        <div class="field"><label>Contact</label><input type="text" id="edit-contact-${id}" value="${escapeHtml(e.hostContact||'')}" maxlength="80"></div>
      </div>
      <div class="field"><label>Description</label><textarea id="edit-desc-${id}" maxlength="400">${escapeHtml(e.description)}</textarea></div>
      <div class="field"><label>Volunteers needed</label><input type="number" id="edit-vol-${id}" min="0" max="200" value="${vol0(e)}"></div>
      ${ui.error ? `<span class="manage-err">${escapeHtml(ui.error)}</span>` : ''}
      <div class="manage-actions">
        <button type="button" class="btn" data-action="save-edit" data-id="${id}">Save changes</button>
        <button type="button" class="btn danger" data-action="cancel-event" data-id="${id}">Cancel this event</button>
        <button type="button" class="btn subtle" data-action="manage-toggle" data-id="${id}">Close</button>
      </div>
    </div>`;
}

function cardHTML(e){
  const dt = parseISO(e.date);
  const badgeClass = CATS[e.category] || 'sage';
  const vol = vol0(e);
  const rc = rsvpCache[e.id] || { count: 0, isIn: false, loaded: false };
  const ui = uiState[e.id] || {};
  const googleUrl = buildGoogleCalUrl(e);
  const photoBlock = e.photoUrl ? `<img class="card-photo" src="${escapeHtml(e.photoUrl)}" alt="">` : '';

  const actionRow = `
    <div class="action-row">
      <button type="button" class="rsvp-btn ${rc.isIn ? 'in' : ''}" data-action="rsvp" data-id="${e.id}">${rc.isIn ? '✓ You\u2019re in' : '🙋 I\u2019m in'}</button>
      <span class="rsvp-count">${rc.loaded ? rc.count : '…'} going</span>
      <div class="cal-links">
        <a href="${googleUrl}" target="_blank" rel="noopener noreferrer">Google</a>
        <button type="button" data-action="ics" data-id="${e.id}">.ics</button>
      </div>
      <button type="button" class="manage-btn" data-action="manage-toggle" data-id="${e.id}">Manage</button>
    </div>`;

  let managePanel = '';
  if (ui.open){
    if (!ui.unlocked){
      managePanel = `
        <div class="manage-panel">
          <div class="row" style="align-items:center;">
            <input type="text" class="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="••••" data-role="code-input" data-id="${e.id}">
            <button type="button" class="btn subtle" data-action="unlock" data-id="${e.id}">Unlock</button>
            <button type="button" class="manage-btn" data-action="manage-toggle" data-id="${e.id}">Close</button>
          </div>
          ${ui.error ? `<span class="manage-err">${escapeHtml(ui.error)}</span>` : `<span class="form-note">Only the person who posted this has the code.</span>`}
        </div>`;
    } else {
      managePanel = editPanelHTML(e, ui);
    }
  }

  return `
    <article class="card">
      ${photoBlock}
      <div class="top-row">
        <div class="date-tab">
          <span class="mon">${MONTHS[dt.getMonth()]}</span>
          <span class="day">${dt.getDate()}</span>
        </div>
        <div>
          <span class="badge ${badgeClass}">${escapeHtml(e.category || 'Community')}</span>
          <h3>${escapeHtml(e.title)}</h3>
        </div>
      </div>
      <div class="meta-line">🕘&nbsp;<b>${escapeHtml(e.time)}</b></div>
      <div class="meta-line">📍&nbsp;<b>${escapeHtml(e.location)}</b></div>
      <p class="desc">${escapeHtml(e.description)}</p>
      <div class="foot">
        <span>Hosted by ${escapeHtml(e.hostName || 'a neighbor')}</span>
        ${vol > 0 ? `<span class="vol-tag">${vol} volunteer${vol===1?'':'s'} needed</span>` : ''}
      </div>
      ${actionRow}
      ${managePanel}
    </article>`;
}

function renderEvents(){
  const grid = document.getElementById('event-grid');
  const today = todayISO();
  let upcoming = allEvents
    .filter(e => e.date >= today)
    .sort((a,b) => (a.date + a.time).localeCompare(b.date + b.time));
  if (activeFilter !== 'All') upcoming = upcoming.filter(e => e.category === activeFilter);

  if (upcoming.length === 0){
    grid.innerHTML = `<div class="empty-state">Nothing posted ${activeFilter === 'All' ? 'yet' : 'in “' + escapeHtml(activeFilter) + '” yet'} — be the first to <a href="#host">add one</a>.</div>`;
  } else {
    // A malformed document (bad data another client wrote, or a legacy
    // record missing a field this version expects) shouldn't take the
    // whole board down -- render what we can, skip what throws.
    grid.innerHTML = upcoming.map(e => {
      try { return cardHTML(e); }
      catch(err){ console.error('card render failed, skipping', e && e.id, err); return ''; }
    }).join('');
    upcoming.forEach(e => ensureRsvpLoaded(e.id));
  }

  // stats
  const now = new Date();
  const thisMonthCount = allEvents.filter(e => {
    const d = parseISO(e.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && e.date >= today;
  }).length;
  const hostSet = new Set(allEvents.filter(e => e.date >= today).map(e => (e.hostName || '').trim().toLowerCase()).filter(Boolean));
  document.getElementById('stat-month').textContent = thisMonthCount;
  document.getElementById('stat-hosts').textContent = hostSet.size;
  const next = allEvents.filter(e => e.date >= today).sort((a,b)=>a.date.localeCompare(b.date))[0];
  document.getElementById('stat-next').textContent = next ? (MONTHS[parseISO(next.date).getMonth()] + ' ' + parseISO(next.date).getDate()) : '—';

  if (adminUnlocked) renderAdminList();
}
renderEvents();

function ensureRsvpLoaded(id){
  if (!firestore || (rsvpCache[id] && rsvpCache[id].loaded)) return;
  const vid = getVisitorId();
  getDocs(query(collection(firestore, 'events', id, 'rsvps'), limit(200)))
    .then(snap => {
      rsvpCache[id] = { count: snap.size, isIn: snap.docs.some(d => d.id === vid), loaded: true };
      renderEvents();
    })
    .catch(() => {});
}

async function deleteEventAndRsvps(id){
  if (!firestore) return;
  try{
    const rsvpSnap = await getDocs(query(collection(firestore, 'events', id, 'rsvps'), limit(200)));
    await Promise.all(rsvpSnap.docs.map(r => deleteDoc(doc(firestore, 'events', id, 'rsvps', r.id))));
  } catch(e){ /* best effort */ }
  try{ await deleteDoc(doc(firestore, 'events', id)); } catch(e){ console.error('delete failed', e); }
}

let prunedOnce = false;
async function pruneOldEvents(){
  if (!firestore || prunedOnce) return;
  prunedOnce = true;
  try{
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60);
    const cutoffISO = cutoff.getFullYear() + '-' + pad(cutoff.getMonth()+1) + '-' + pad(cutoff.getDate());
    const snap = await getDocs(query(collection(firestore, 'events'), where('date','<',cutoffISO), limit(20)));
    await Promise.all(snap.docs.map(d => deleteEventAndRsvps(d.id)));
  } catch(e){ /* silent -- cleanup is best-effort */ }
}

// ---- event delegation for card actions ----
document.getElementById('event-grid').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'rsvp') return handleRsvp(id);
  if (action === 'ics') return handleIcs(id);
  if (action === 'manage-toggle') return handleManageToggle(id);
  if (action === 'unlock') return handleUnlock(id);
  if (action === 'save-edit') return handleSaveEdit(id);
  if (action === 'cancel-event') return handleCancelPrompt(id);
  if (action === 'confirm-cancel') return handleConfirmCancel(id);
  if (action === 'deny-cancel') return handleDenyCancel(id);
});

async function handleRsvp(id){
  if (!firestore) return;
  const vid = getVisitorId();
  const rsvpDocRef = doc(firestore, 'events', id, 'rsvps', vid);
  const cur = rsvpCache[id] || { count: 0, isIn: false, loaded: true };
  try{
    if (cur.isIn){
      await deleteDoc(rsvpDocRef);
      rsvpCache[id] = { count: Math.max(0, cur.count - 1), isIn: false, loaded: true };
    } else {
      await setDoc(rsvpDocRef, { at: Date.now() });
      rsvpCache[id] = { count: cur.count + 1, isIn: true, loaded: true };
    }
  } catch(e){ console.error('rsvp failed', e); }
  renderEvents();
}

async function handleIcs(id){
  const e = allEvents.find(x => x.id === id);
  if (!e) return;
  try{ downloadIcs(e); } catch(err){ console.error('ics download failed', err); }
}

function handleManageToggle(id){
  const cur = uiState[id];
  uiState[id] = (cur && cur.open)
    ? { open: false, unlocked: false, error: null, confirmingDelete: false }
    : { ...(cur||{}), open: true, error: null };
  renderEvents();
}

async function handleUnlock(id){
  const input = document.querySelector(`[data-role="code-input"][data-id="${id}"]`);
  const val = input ? input.value.trim() : '';
  if (!/^\d{4}$/.test(val)){
    uiState[id] = { ...(uiState[id]||{}), open: true, error: 'Enter the 4-digit code.' };
    return renderEvents();
  }
  const e = allEvents.find(x => x.id === id);
  let hash;
  try{ hash = await sha256Hex(val); }
  catch(err){
    uiState[id] = { ...(uiState[id]||{}), open: true, error: "Edit codes aren't available in this browser." };
    return renderEvents();
  }
  if (!e || !e.editCodeHash || e.editCodeHash !== hash){
    uiState[id] = { ...(uiState[id]||{}), open: true, error: "That code doesn't match." };
    return renderEvents();
  }
  uiState[id] = { open: true, unlocked: true, error: null };
  renderEvents();
}

async function handleSaveEdit(id){
  const e = allEvents.find(x => x.id === id);
  if (!e) return;
  const g = field => { const el = document.getElementById(`edit-${field}-${id}`); return el ? el.value : ''; };
  const updated = {
    title: g('title').trim(),
    category: g('category') || e.category,
    date: g('date') || e.date,
    time: g('time').trim(),
    startTime: g('start') || '',
    endTime: g('end') || '',
    location: g('location').trim(),
    hostName: g('host').trim(),
    hostContact: g('contact').trim(),
    description: g('desc').trim(),
    volunteersNeeded: Number(g('vol')) || 0
  };
  if (!updated.title || !updated.date || !updated.time || !updated.location || !updated.hostName || !updated.description){
    uiState[id] = { ...uiState[id], error: 'Fill in the required fields.' };
    return renderEvents();
  }
  try{
    await updateDoc(doc(firestore, 'events', id), updated);
    uiState[id] = { open: false, unlocked: false, error: null };
    renderEvents();
  } catch(err){
    uiState[id] = { ...uiState[id], error: "Couldn't save — please try again." };
    renderEvents();
  }
}

function handleCancelPrompt(id){
  uiState[id] = { ...(uiState[id]||{}), confirmingDelete: true, error: null };
  renderEvents();
}
function handleDenyCancel(id){
  uiState[id] = { ...(uiState[id]||{}), confirmingDelete: false };
  renderEvents();
}
async function handleConfirmCancel(id){
  await deleteEventAndRsvps(id);
  delete uiState[id];
  allEvents = allEvents.filter(e => e.id !== id);
  renderEvents();
}

// ---- Firebase wiring ----
try{
  const app = initializeApp(firebaseConfig);
  firestore = getFirestore(app);
  try{ storageService = getStorage(app); } catch(e){ storageService = null; }
} catch(e){
  console.error('firebase init failed', e);
}

if (!firestore){
  document.getElementById('form-status').textContent = 'Live posting isn’t available right now.';
  document.getElementById('form-status').className = 'form-status err';
} else {
  const eventsQuery = query(collection(firestore, 'events'), orderBy('date','asc'), limit(500));
  onSnapshot(eventsQuery,
    snap => {
      allEvents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderEvents();
      pruneOldEvents();
    },
    err => console.error('events subscription error', err)
  );
}

// ---- form submit ----
const form = document.getElementById('event-form');
const statusEl = document.getElementById('form-status');
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!firestore){
    statusEl.textContent = 'Board isn’t connected right now — try reopening the page.';
    statusEl.className = 'form-status err';
    return;
  }
  const fd = new FormData(form);

  // honeypot — bots that fill every field get a fake success, no write
  if ((fd.get('website') || '').toString().trim()){
    form.reset();
    statusEl.textContent = 'Posted — it’s on the board below.';
    statusEl.className = 'form-status ok';
    return;
  }

  // throttle repeat posting from this browser
  let lastSubmit = 0;
  try{ lastSubmit = Number(localStorage.getItem('mt_last_submit')) || 0; } catch(e){}
  const waitMs = SUBMIT_COOLDOWN_MS - (Date.now() - lastSubmit);
  if (waitMs > 0){
    statusEl.textContent = `Please wait ${Math.ceil(waitMs/1000)}s before posting again.`;
    statusEl.className = 'form-status err';
    return;
  }

  const editCode = (fd.get('editCode') || '').toString().trim();
  if (!/^\d{4}$/.test(editCode)){
    statusEl.textContent = 'Edit code must be exactly 4 digits.';
    statusEl.className = 'form-status err';
    return;
  }

  const data = {
    title: (fd.get('title') || '').toString().trim(),
    category: (fd.get('category') || '').toString(),
    date: (fd.get('date') || '').toString(),
    time: (fd.get('time') || '').toString().trim(),
    startTime: (fd.get('startTime') || '').toString(),
    endTime: (fd.get('endTime') || '').toString(),
    location: (fd.get('location') || '').toString().trim(),
    hostName: (fd.get('hostName') || '').toString().trim(),
    hostContact: (fd.get('hostContact') || '').toString().trim(),
    description: (fd.get('description') || '').toString().trim(),
    volunteersNeeded: Number(fd.get('volunteersNeeded')) || 0,
    photoAssetId: '',
    photoUrl: '',
    createdAt: Date.now()
  };
  if (!data.title || !data.category || !data.date || !data.time || !data.location || !data.hostName || !data.description){
    statusEl.textContent = 'Fill in the required fields first.';
    statusEl.className = 'form-status err';
    return;
  }

  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = true;
  statusEl.textContent = 'Posting…';
  statusEl.className = 'form-status';
  try{
    data.editCodeHash = await sha256Hex(editCode);

    const photo = fd.get('photo');
    if (photo && photo.size > 0 && storageService){
      try{
        const path = 'event-photos/' + Date.now() + '-' + slugify(data.title) + '-' + photo.name.replace(/[^a-zA-Z0-9.]+/g,'-');
        const fileRef = storageRef(storageService, path);
        await uploadBytes(fileRef, photo);
        data.photoUrl = await getDownloadURL(fileRef);
        data.photoAssetId = path;
      } catch(err){ console.error('photo upload failed', err); }
    }

    await addDoc(collection(firestore, 'events'), data);
    form.reset();
    try{ localStorage.setItem('mt_last_submit', String(Date.now())); } catch(e){}
    statusEl.textContent = 'Posted — it’s on the board below.';
    statusEl.className = 'form-status ok';
    document.getElementById('board').scrollIntoView({ behavior:'smooth', block:'start' });
  } catch(e){
    console.error('submit failed', e);
    statusEl.textContent = 'Couldn’t post that — please try again.';
    statusEl.className = 'form-status err';
  } finally{
    submitBtn.disabled = false;
  }
});

// ---- admin panel ----
const adminOverlay = document.getElementById('admin-overlay');
document.getElementById('admin-open').addEventListener('click', () => { adminOverlay.hidden = false; });
document.getElementById('admin-close').addEventListener('click', closeAdmin);
adminOverlay.addEventListener('click', ev => { if (ev.target === adminOverlay) closeAdmin(); });
function closeAdmin(){ adminOverlay.hidden = true; }

document.getElementById('admin-unlock').addEventListener('click', async () => {
  const val = document.getElementById('admin-pass').value;
  const errEl = document.getElementById('admin-error');
  let hash;
  try{ hash = await sha256Hex(val); }
  catch(e){ errEl.textContent = "Admin unlock isn't available in this browser."; return; }
  if (hash === ADMIN_HASH){
    adminUnlocked = true;
    errEl.textContent = '';
    document.getElementById('admin-gate').hidden = true;
    document.getElementById('admin-list').hidden = false;
    renderAdminList();
  } else {
    errEl.textContent = "That passphrase doesn't match.";
  }
});

function renderAdminList(){
  const el = document.getElementById('admin-list');
  if (!el) return;
  const sorted = [...allEvents].sort((a,b) => b.date.localeCompare(a.date));
  if (sorted.length === 0){
    el.innerHTML = '<p class="form-note">No listings yet.</p>';
    return;
  }
  el.innerHTML = sorted.map(e => `
    <div class="admin-row">
      <div>
        <div><strong>${escapeHtml(e.title)}</strong></div>
        <div class="meta">${escapeHtml(e.date)} · ${escapeHtml(e.category || '')} · hosted by ${escapeHtml(e.hostName || '—')}${e.hostContact ? ' · ' + escapeHtml(e.hostContact) : ''}</div>
      </div>
      <button type="button" class="admin-remove" data-admin-remove="${e.id}">Remove</button>
    </div>`).join('');
  el.querySelectorAll('[data-admin-remove]').forEach(b => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      await deleteEventAndRsvps(b.dataset.adminRemove);
      allEvents = allEvents.filter(e => e.id !== b.dataset.adminRemove);
      renderAdminList();
      renderEvents();
    });
  });
}
