// service_worker.js — v7 ZIP-all attachments
let aborter = null;
let currentToken = null;

async function appendLog(text, level=''){
  const st = await chrome.storage.local.get({ activityLog: [], logSeq: -1 });
  let { activityLog, logSeq } = st;
  if (!Array.isArray(activityLog)) activityLog = [];
  if (typeof logSeq !== 'number') logSeq = -1;
  const seq = logSeq + 1;
  const entry = { seq, ts: Date.now(), level, text };
  activityLog.push(entry);
  if (activityLog.length > 500) activityLog = activityLog.slice(-500);
  await chrome.storage.local.set({ activityLog, logSeq: seq });
  safeSend({ type:'STATUS', log:text, level, seq })
  return seq;
}

function safeSend(message){
  try {
    chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
  } catch (e) { /* ignore if no receiver */ }
}



const WEB_CLIENT_ID = "206612498563-64nsv1gn4i886bsompu6sq80vlcd6kcq.apps.googleusercontent.com";

function notifyStatus(extra={}){
  chrome.storage.local.get({
    phase:'idle', query:'', nameFilter:'', messagesProcessed:0, totalMessages:0,
    pdfFound:0, pdfDownloaded:0, attachments:[], email:''
  }, (st)=>{
    const payload = {
      type:'STATUS',
      messagesProcessed: st.messagesProcessed,
      totalMessages: st.totalMessages,
      pdfFound: st.pdfFound,
      pdfDownloaded: st.pdfDownloaded,
      attachmentsCount: (st.attachments||[]).length,
      ...extra
    };
    safeSend(payload)
  });
}

async function getProfileEmail(){
  try{
    const data = await gmailFetch('profile');
    if (data && data.emailAddress) {
      await chrome.storage.local.set({ email: data.emailAddress });
      return data.emailAddress;
    }
  }catch(e){}
  return '';
}

async function connect(){
  if (WEB_CLIENT_ID){
    const redirectUri = chrome.identity.getRedirectURL();
    const params = new URLSearchParams({
      client_id: WEB_CLIENT_ID,
      response_type: 'token',
      redirect_uri: redirectUri,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      prompt: 'select_account consent',
      include_granted_scopes: 'true'
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    const responseUrl = await new Promise((resolve, reject)=>{
      chrome.identity.launchWebAuthFlow({url: authUrl, interactive: true}, (redirected) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(redirected);
      });
    });
    const hash = new URL(responseUrl).hash.substring(1);
    const data = Object.fromEntries(new URLSearchParams(hash));
    if (!data.access_token) throw new Error('Token non ottenuto (web flow)');
    currentToken = data.access_token;
    await chrome.storage.local.set({ token: currentToken });
    const email = await getProfileEmail();
    return email;
  } else {
    return new Promise((resolve, reject)=>{
      chrome.identity.getAuthToken({ interactive: true }, async (token)=>{
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        currentToken = token;
        await chrome.storage.local.set({ token: currentToken });
        const after = getProfileEmail().then(email=>resolve(email)).catch(()=>resolve(''));
      });
    });
  }
}

async function ensureToken(interactive=true){
  if (currentToken) return currentToken;
  const st = await chrome.storage.local.get({ token:null });
  if (st.token) { currentToken = st.token; return currentToken; }
  await connect();
  return currentToken;
}

async function gmailFetch(path, params={}, method='GET', attempt=0){
  if (!currentToken) await ensureToken(true);
  const url = new URL(`https://www.googleapis.com/gmail/v1/users/me/${path}`);
  if (method==='GET'){
    Object.entries(params).forEach(([k,v])=>{ if (v!==undefined && v!==null && !(typeof v==='string' && v.length===0)) url.searchParams.set(k,v); });
  }
  const headers = { 'Authorization': `Bearer ${currentToken}` };
  aborter = new AbortController();
  const resp = await fetch(url.toString(), { method, headers, signal: aborter.signal });
  if (resp.status === 401 && attempt < 1){
    await new Promise(res=>chrome.identity.removeCachedAuthToken({ token: currentToken }, res));
    currentToken = null;
    await ensureToken(true);
    return gmailFetch(path, params, method, attempt+1);
  }
  if ((resp.status===429 || resp.status===503) && attempt < 5){
    const delay = Math.pow(2, attempt)*300;
    await new Promise(res=>setTimeout(res, delay));
    return gmailFetch(path, params, method, attempt+1);
  }
  if (!resp.ok){
    const text = await resp.text();
    throw new Error(`Gmail API ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function listAllMessages(q){
  let nextPageToken = undefined;
  const acc = [];
  do{
    const params = { q, maxResults: 500 };
    if (nextPageToken) params.pageToken = nextPageToken;
    const page = await gmailFetch('messages', params);
    if (page.messages) acc.push(...page.messages);
    nextPageToken = page.nextPageToken || undefined;
    const st = await chrome.storage.local.get({ totalMessages:0, messagesProcessed:0 });
    await chrome.storage.local.set({ totalMessages: (st.totalMessages || 0) + (page.messages? page.messages.length:0) });
    await appendLog(`Recuperate ${acc.length} email…`); notifyStatus({});
  } while(nextPageToken);
  return acc;
}

async function getMessage(id){ return gmailFetch(`messages/${id}`, { format: 'full' }); }

function collectPdfAttachments(message){
  const results = [];
  function walk(part){
    if (!part) return;
    if (part.filename && part.filename.toLowerCase().endsWith('.pdf') && part.body && part.body.attachmentId){
      results.push({ attachmentId: part.body.attachmentId, filename: part.filename });
    }
    if (part.parts && Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(message.payload);
  return results;
}

async function getAttachment(messageId, attachmentId){ return gmailFetch(`messages/${messageId}/attachments/${attachmentId}`); }

// ---- ZIP (store) builder (no compression) ----
function crc32Uint8(uint8){
  // standard CRC32
  let table = crc32Uint8.table;
  if (!table){
    table = new Uint32Array(256);
    for (let i=0;i<256;i++){
      let c = i;
      for (let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    crc32Uint8.table = table;
  }
  let crc = 0xFFFFFFFF;
  for (let i=0;i<uint8.length;i++){
    crc = table[(crc ^ uint8[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosTimeDate(d=new Date()){
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds()/2))) & 0xFFFF;
  const date = (((d.getFullYear()-1980) << 9) | ((d.getMonth()+1) << 5) | d.getDate()) & 0xFFFF;
  return {time, date};
}

function encodeUTF8(str){
  return new TextEncoder().encode(str);
}


function buildZipStore(files){
  // files: [{name:string, data:Uint8Array}]
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  const now = dosTimeDate();
  for (const f of files){
    const nameBytes = encodeUTF8(f.name);
    const crc = crc32Uint8(f.data);
    const size = f.data.length >>> 0;

    const lh = new Uint8Array(30 + nameBytes.length + size);
    const dv = new DataView(lh.buffer);
    let p = 0;
    dv.setUint32(p, 0x04034b50, true); p+=4;
    dv.setUint16(p, 20, true); p+=2;
    dv.setUint16(p, 0, true); p+=2;
    dv.setUint16(p, 0, true); p+=2;
    dv.setUint16(p, now.time, true); p+=2;
    dv.setUint16(p, now.date, true); p+=2;
    dv.setUint32(p, crc, true); p+=4;
    dv.setUint32(p, size, true); p+=4;
    dv.setUint32(p, size, true); p+=4;
    dv.setUint16(p, nameBytes.length, true); p+=2;
    dv.setUint16(p, 0, true); p+=2;
    lh.set(nameBytes, p); p += nameBytes.length;
    lh.set(f.data, p);
    localHeaders.push(lh);

    const ch = new Uint8Array(46 + nameBytes.length);
    const dv2 = new DataView(ch.buffer);
    p = 0;
    dv2.setUint32(p, 0x02014b50, true); p+=4;
    dv2.setUint16(p, 20, true); p+=2;
    dv2.setUint16(p, 20, true); p+=2;
    dv2.setUint16(p, 0, true); p+=2;
    dv2.setUint16(p, 0, true); p+=2;
    dv2.setUint16(p, now.time, true); p+=2;
    dv2.setUint16(p, now.date, true); p+=2;
    dv2.setUint32(p, crc, true); p+=4;
    dv2.setUint32(p, size, true); p+=4;
    dv2.setUint32(p, size, true); p+=4;
    dv2.setUint16(p, nameBytes.length, true); p+=2;
    dv2.setUint16(p, 0, true); p+=2;
    dv2.setUint16(p, 0, true); p+=2;
    dv2.setUint16(p, 0, true); p+=2;
    dv2.setUint16(p, 0, true); p+=2;
    dv2.setUint32(p, 0, true); p+=4;
    dv2.setUint32(p, offset, true); p+=4;
    ch.set(nameBytes, p);
    centralHeaders.push({ch, offset, size: lh.length});
    offset += lh.length;
  }

  const cdSize = centralHeaders.reduce((s,x)=>s + x.ch.length, 0);
  const cdStart = offset;
  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const lh of localHeaders){ out.set(lh, pos); pos += lh.length; }
  for (const ent of centralHeaders){ out.set(ent.ch, pos); pos += ent.ch.length; }

  const dv3 = new DataView(out.buffer);
  let p = pos;
  dv3.setUint32(p, 0x06054b50, true); p+=4;
  dv3.setUint16(p, 0, true); p+=2;
  dv3.setUint16(p, 0, true); p+=2;
  dv3.setUint16(p, centralHeaders.length, true); p+=2;
  dv3.setUint16(p, centralHeaders.length, true); p+=2;
  dv3.setUint32(p, cdSize, true); p+=4;
  dv3.setUint32(p, cdStart, true); p+=4;
  dv3.setUint16(p, 0, true); p+=2;
  return out; // Uint8Array
}


function b64urlToUint8(b64url){
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 2 ? '==' : (b64.length % 4 === 3 ? '=' : '');
  const bin = atob(b64 + pad);
  const arr = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function uint8ToBase64(u8){
  let binary = '';
  const chunk = 0x8000;
  for (let i=0;i<u8.length;i+=chunk){
    binary += String.fromCharCode.apply(null, u8.subarray(i,i+chunk));
  }
  return btoa(binary);
}

// ----------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  (async ()=>{
    try{
      if (msg.cmd === 'CONNECT'){
        await chrome.storage.local.remove('token');
        currentToken = null;
        const email = await connect();
        sendResponse && sendResponse({ ok:true, email });
        return;
      }
      if (msg.cmd === 'START'){
        await chrome.storage.local.set({
          phase:'searching', query: msg.q, nameFilter: msg.nameFilter,
          messagesProcessed:0, totalMessages:0, pdfFound:0, pdfDownloaded:0,
          attachments:[], canceled:false
        });
        await ensureToken(true);
        const email = await getProfileEmail();
        await appendLog(`Connesso come ${email}. Inizio ricerca…`); notifyStatus({});
        const messages = await listAllMessages(msg.q);
        let messagesProcessed = 0;
        let attachments = [];
        const nameRe = msg.nameFilter ? new RegExp(msg.nameFilter, 'i') : null;
        for (let i=0;i<messages.length;i++){
          const st = await chrome.storage.local.get({ canceled:false });
          if (st.canceled){ await appendLog('Operazione annullata.'); notifyStatus({}); break; }
          const m = await getMessage(messages[i].id);
          let pdfs = collectPdfAttachments(m).map(p => ({ messageId: m.id, ...p }));
          if (nameRe) pdfs = pdfs.filter(x => nameRe.test(x.filename));
          attachments = attachments.concat(pdfs);
          messagesProcessed++;
          await chrome.storage.local.set({ messagesProcessed, attachments, pdfFound: attachments.length });
          if (i % 10 === 0) await appendLog(`Analizzate ${messagesProcessed}/${messages.length} email…`); notifyStatus({});
        }
        await chrome.storage.local.set({ phase:'ready' });
        await appendLog(`Trovati ${attachments.length} PDF. Pronto al download ZIP.`,'ok'); notifyStatus({});
      }
      if (msg.cmd === 'DOWNLOAD'){
        const st = await chrome.storage.local.get({ attachments:[], canceled:false });
        await chrome.storage.local.set({ phase:'downloading' });
        await appendLog(`Creo archivio ZIP da ${st.attachments.length} file…`); notifyStatus({});
        const files = [];
        for (let i=0;i<st.attachments.length;i++){
          const cur = await chrome.storage.local.get({ canceled:false });
          if (cur.canceled){ await appendLog('Download annullato.'); notifyStatus({}); break; }
          const a = st.attachments[i];
          const data = await getAttachment(a.messageId, a.attachmentId);
          const bytes = b64urlToUint8(data.data);
          const safeName = a.filename && a.filename.trim() ? a.filename.trim() : `allegato_${i+1}.pdf`;
          files.push({ name: safeName, data: bytes });
          if (i % 5 === 0) await appendLog(`Raccolti ${i+1}/${st.attachments.length} file…`); notifyStatus({});
        }
        const zipBytes = buildZipStore(files);
const base64 = uint8ToBase64(zipBytes);
const url = `data:application/zip;base64,${base64}`;
const now = new Date();
        const stamp = now.toISOString().replace(/[:T]/g,'-').slice(0,16);
        const zipName = `gmail-pdf-${stamp}.zip`;
        await new Promise((resolve, reject)=>{
          chrome.downloads.download({ url, filename: zipName, saveAs: true }, (id)=>{
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(id);
          });
        });
        await appendLog(`ZIP scaricato: ${zipName}`,'ok'); notifyStatus({});
        await chrome.storage.local.set({ phase:'done' });
      }
      if (msg.cmd === 'CANCEL'){
        await chrome.storage.local.set({ canceled:true });
        if (aborter) try{ aborter.abort(); }catch(e){}
        await appendLog('Richiesta di annullamento ricevuta.'); notifyStatus({});
      }
      if (msg.cmd === 'RESET'){
        // Preserve token & email; reset everything else
        const keep = await chrome.storage.local.get({ token:null, email:'' });
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          token: keep.token || null,
          email: keep.email || '',
          phase:'idle', query:'', nameFilter:'',
          messagesProcessed:0, totalMessages:0, pdfFound:0, pdfDownloaded:0,
          attachments:[], canceled:false, activityLog:[], logSeq:-1
        });
        await appendLog('Stato azzerato (accesso conservato).','ok'); 
        notifyStatus({});
      }
      if (msg.cmd === 'STATUS'){
        notifyStatus({});
      }
      sendResponse && sendResponse({ok:true});
    }catch(e){
      await appendLog(`Errore: ${e.message}`,'warnText'); notifyStatus({});
      sendResponse && sendResponse({ok:false, error:e.message});
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async ()=>{ await chrome.storage.local.clear(); await chrome.storage.local.set({ activityLog: [], logSeq: -1 }); });
