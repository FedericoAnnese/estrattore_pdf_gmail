// popup.js — one-button connect; persistent progress; modern UI

const logEl = document.getElementById('log');
const whoEl = document.getElementById('who');
const queryEl = document.getElementById('query');
const nameFilterEl = document.getElementById('nameFilter');
const connectBtn = document.getElementById('connectBtn');
const startBtn = document.getElementById('startBtn');
const downloadBtn = document.getElementById('downloadBtn');
const cancelBtn = document.getElementById('cancelBtn');
const resetBtn = document.getElementById('resetBtn');
const diag = document.getElementById('diag');

const s_msg = document.getElementById('s_msg');
const s_pdf = document.getElementById('s_pdf');
const p_msg = document.getElementById('p_msg');
const p_pdf = document.getElementById('p_pdf');

let lastSeqRendered = -1;

async function renderLogFromStorage() {
  const st = await chrome.storage.local.get({ activityLog: [] });
  const logs = st.activityLog || [];
  for (const item of logs) {
    if (typeof item.seq === 'number' && item.seq > lastSeqRendered) {
      const cls = item.level || '';
      const text = item.text || '';
      const p = document.createElement('div');
      if (cls) p.className = cls;
      p.textContent = text;
      logEl.appendChild(p);
      lastSeqRendered = item.seq;
    }
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function log(msg, cls='') {
  const p = document.createElement('div');
  if (cls) p.className = cls;
  p.textContent = msg;
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
}
function clearLog(){ logEl.textContent=''; }

function setStats({messagesProcessed=0,totalMessages=0,pdfFound=0,pdfDownloaded=0}){
  s_msg.textContent = `${messagesProcessed}/${totalMessages || '?'}`;
  s_pdf.textContent = `${pdfFound}`;
  const mPerc = totalMessages ? Math.min(100, Math.round(messagesProcessed/totalMessages*100)) : 0;
  const pPerc = pdfFound ? Math.min(100, Math.round(pdfDownloaded/pdfFound*100)) : 0;
  p_msg.style.width = mPerc + '%';
  p_pdf.style.width = pPerc + '%';
}

async function loadState(){
  const st = await chrome.storage.local.get({
    phase:'idle', query:'', nameFilter:'', messagesProcessed:0, totalMessages:0,
    pdfFound:0, pdfDownloaded:0, attachments:[], token:null, email:''
  });
  queryEl.value = st.query || '';
  nameFilterEl.value = st.nameFilter || '';
  setStats(st);
  downloadBtn.disabled = !(st.attachments && st.attachments.length);
  if (st.email){ whoEl.textContent = `Connesso come: ${st.email}`; }
  const redirectUri = chrome.identity.getRedirectURL();
  return st;
}

async function saveQueryUI(){
  await chrome.storage.local.set({ query: queryEl.value.trim(), nameFilter: nameFilterEl.value.trim() });
}

async function send(cmd, data={}){ return chrome.runtime.sendMessage({cmd, ...data}); }

connectBtn.addEventListener('click', async ()=>{
  clearLog();
  log('Connessione / selezione account…');
  const st = await chrome.storage.local.get({ token:null });
  if (st.token){
    await new Promise(res => chrome.identity.removeCachedAuthToken({ token: st.token }, res));
    await chrome.storage.local.remove('token');
  }
  const resp = await send('CONNECT');
  if (resp && resp.email){ whoEl.textContent = `Connesso come: ${resp.email}`; }
});

startBtn.addEventListener('click', async ()=>{
  await saveQueryUI();
  clearLog();
  log('Avvio ricerca…');
  try {
    const q = queryEl.value.trim() || 'filename:pdf';
    const nameFilter = nameFilterEl.value.trim();
    await send('START', { q, nameFilter });
  } catch(e){ log(`Errore avvio: ${e.message}`,'warnText'); }
});

downloadBtn.addEventListener('click', async ()=>{
  clearLog(); log('Avvio download…');
  await send('DOWNLOAD');
});
cancelBtn.addEventListener('click', async ()=>{
  await send('CANCEL'); log('Richiesta terminazione inviata.','warnText');
});
resetBtn.addEventListener('click', async ()=>{
  await send('RESET'); clearLog(); setStats({}); downloadBtn.disabled = true; log('Stato ripristinato.','ok');
});

chrome.runtime.onMessage.addListener((msg)=>{
  if (msg.type === 'STATUS'){
    if (msg.log && typeof msg.seq === 'number' && msg.seq > lastSeqRendered) { log(msg.log, msg.level || ''); lastSeqRendered = msg.seq; }
    setStats(msg);
    if (typeof msg.attachmentsCount === 'number'){
      downloadBtn.disabled = msg.attachmentsCount === 0;
    }
  }
});

(async ()=>{ await loadState(); await renderLogFromStorage(); await send('STATUS'); })();
