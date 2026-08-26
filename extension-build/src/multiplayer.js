import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, get, onChildAdded, onDisconnect, onValue, push, ref, remove, runTransaction, serverTimestamp, set, update } from "firebase/database";

(() => {
  const firebaseConfig = {
    apiKey: "AIzaSyAMIcduudXrvwiJnhx1BoQVGIepeCwYTkw",
    authDomain: "y-gitadora.firebaseapp.com",
    databaseURL: "https://y-gitadora-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "y-gitadora",
    storageBucket: "y-gitadora.firebasestorage.app",
    messagingSenderId: "1088976588214",
    appId: "1:1088976588214:web:24d525fb291c4942ae8517",
  };
  const firebaseApp = initializeApp(firebaseConfig);
  const auth = getAuth(firebaseApp);
  const db = getDatabase(firebaseApp);
  const LATE_LIMIT_MS = 80;
  const HOST_GRACE_MS = 5 * 60 * 1000;
  const encoder = new TextEncoder();
  const gameApi = globalThis.__sdgGameApi;
  if (!gameApi) return;
  const mp = {
    roomId: "", playerId: "", name: "", hostId: null, hostEpoch: 0, songEpoch: 0,
    players: [], peers: new Map(), serverOffset: 0, song: null, unsubs: [], lastStartId: "", hostElectionTimer:null, hostElectionFor:null,
  };

  const panel = document.createElement("section");
  panel.id = "sdg-multiplayer";
  panel.className = "collapsed";
  panel.innerHTML = `<h3><span>ONLINE SESSION</span><button id="sdg-mp-toggle">連線合奏</button></h3><div class="sdg-mp-body"><div class="sdg-mp-row"><input id="sdg-mp-name" maxlength="24" placeholder="玩家名稱"><button id="sdg-mp-create">建立</button></div><div class="sdg-mp-row"><input id="sdg-mp-room" maxlength="6" placeholder="6位房號"><button id="sdg-mp-join">加入</button><button id="sdg-mp-leave">離開</button></div><div>房號 <span class="sdg-mp-code" id="sdg-mp-code">------</span></div><div id="sdg-mp-status">尚未連線</div><div id="sdg-mp-players"></div><div class="sdg-mp-row"><button id="sdg-mp-song">同步目前歌曲</button><button id="sdg-mp-ready">準備</button><button id="sdg-mp-start">全員開始</button></div></div>`;
  gameApi.root().querySelector("#sdg-settings-side").append(panel);
  const $mp = (selector) => panel.querySelector(selector);
  $mp("#sdg-mp-toggle").onclick = () => panel.classList.toggle("collapsed");

  function status(text, type = "") {
    const element = $mp("#sdg-mp-status");
    element.textContent = text;
    element.className = type ? `sdg-mp-${type}` : "";
  }

  async function identity() {
    const stored = await chrome.storage.local.get(["multiplayerName"]);
    if (!auth.currentUser) await signInAnonymously(auth);
    mp.playerId = auth.currentUser.uid;
    mp.name = stored.multiplayerName || `PLAYER-${mp.playerId.slice(0, 4).toUpperCase()}`;
    await chrome.storage.local.set({ multiplayerName: mp.name });
    $mp("#sdg-mp-name").value = mp.name;
  }

  function makeRoomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, (value) => String(value % 10)).join("");
  }

  async function createRoom() {
    saveName();
    status("正在建立房間…", "wait");
    for (let attempt = 0; attempt < 8; attempt++) {
      const roomId = makeRoomCode(), metaRef = ref(db, `rooms/${roomId}/meta`);
      const result = await runTransaction(metaRef, (current) => current || { hostId: mp.playerId, hostEpoch: 1, songEpoch: 0, createdAt: Date.now() });
      if (result.committed && result.snapshot.val()?.hostId === mp.playerId) return connect(roomId);
    }
    throw Error("無法產生未使用的房號，請重試");
  }

  function saveName() {
    mp.name = ($mp("#sdg-mp-name").value.trim() || mp.name).slice(0, 24);
    chrome.storage.local.set({ multiplayerName: mp.name });
  }

  async function joinRoom() {
    saveName();
    const roomId = $mp("#sdg-mp-room").value.trim().toUpperCase();
    if (!/^\d{6}$/.test(roomId)) return status("請輸入6位數字房號", "error");
    const exists = await get(ref(db, `rooms/${roomId}/meta`));
    if (!exists.exists()) return status("找不到這個房間", "error");
    connect(roomId);
  }

  function disconnectRoom() {
    cancelHostElection();
    closePeers();
    for (const unsub of mp.unsubs.splice(0)) try { unsub(); } catch {}
    if (mp.roomId && mp.playerId) remove(ref(db, `rooms/${mp.roomId}/players/${mp.playerId}`)).catch(()=>{});
  }

  async function leaveRoom() {
    disconnectRoom(); mp.roomId=""; mp.players=[]; mp.hostId=null; mp.song=null;
    await chrome.storage.local.remove("sdgMultiplayerResume");
    $mp("#sdg-mp-code").textContent="------"; renderPlayers(); status("已離開房間");
  }

  async function connect(roomId) {
    disconnectRoom();
    mp.roomId = roomId;
    $mp("#sdg-mp-code").textContent = roomId;
    $mp("#sdg-mp-room").value = roomId;
    status("連接Firebase房間…", "wait");
    const playersRef = ref(db, `rooms/${roomId}/players`), playerRef = ref(db, `rooms/${roomId}/players/${mp.playerId}`);
    const existingPlayers = await get(playersRef);
    if (!existingPlayers.hasChild(mp.playerId) && existingPlayers.size >= 4) throw Error("房間已滿");
    await set(playerRef, { name: mp.name, ready: false, readyEpoch: 0, joinedAt: Date.now(), lastSeenAt: serverTimestamp() });
    await onDisconnect(playerRef).remove();
    mp.unsubs.push(onValue(ref(db, ".info/serverTimeOffset"), (snapshot) => { mp.serverOffset = Number(snapshot.val()) || 0; }));
    mp.unsubs.push(onValue(ref(db, `rooms/${roomId}/meta`), (snapshot) => onMeta(snapshot.val())));
    mp.unsubs.push(onValue(playersRef, (snapshot) => onPlayers(snapshot.val() || {})));
    mp.unsubs.push(onChildAdded(ref(db, `rooms/${roomId}/signals/${mp.playerId}`), async (snapshot) => {
      const message = snapshot.val();
      if (message?.from && message?.data) await receiveSignal(message.from, message.data);
      await remove(snapshot.ref);
    }));
    mp.unsubs.push(onValue(ref(db, `rooms/${roomId}/commands/start`), (snapshot) => {
      const command = snapshot.val();
      if (!command?.id || command.id === mp.lastStartId) return;
      mp.lastStartId = command.id; beginSynchronized(command.serverStartAt);
    }));
    status("已進房，建立玩家直連中…", "wait");
    chrome.storage.local.set({ sdgMultiplayerResume: { roomId, name: mp.name, savedAt: Date.now() } });
  }

  function onMeta(meta) {
    if (!meta) return;
    const previousSongEpoch=mp.songEpoch;
    mp.hostId = meta.hostId; mp.hostEpoch = Number(meta.hostEpoch) || 0; mp.songEpoch = Number(meta.songEpoch) || 0; mp.song = meta.song || null;
    if(previousSongEpoch!==mp.songEpoch&&mp.roomId)update(ref(db,`rooms/${mp.roomId}/players/${mp.playerId}`),{ready:false,readyEpoch:mp.songEpoch,lastSeenAt:serverTimestamp()}).catch(()=>{});
    renderPlayers(); verifyRoomSong();
  }

  async function onPlayers(value) {
    mp.players = Object.entries(value).map(([playerId, player]) => ({ playerId, ...player }));
    if (mp.hostId && !value[mp.hostId] && mp.players.length) scheduleHostElection(mp.hostId);
    else cancelHostElection();
    reconcilePeers(); renderPlayers();
  }

  function cancelHostElection(){if(mp.hostElectionTimer)clearTimeout(mp.hostElectionTimer);mp.hostElectionTimer=null;mp.hostElectionFor=null}

  function scheduleHostElection(missingHostId){
    if(mp.hostElectionTimer&&mp.hostElectionFor===missingHostId)return;
    cancelHostElection();mp.hostElectionFor=missingHostId;
    mp.hostElectionTimer=setTimeout(async()=>{
      try{
        const [metaSnapshot,playersSnapshot]=await Promise.all([get(ref(db,`rooms/${mp.roomId}/meta`)),get(ref(db,`rooms/${mp.roomId}/players`))]);
        const meta=metaSnapshot.val(),playersValue=playersSnapshot.val()||{};
        if(!meta||meta.hostId!==missingHostId||playersValue[missingHostId])return;
        mp.players=Object.entries(playersValue).map(([playerId,player])=>({playerId,...player}));
        if(mp.players.length)await electHost();
      }catch(error){status(`房主接任失敗：${error.message}`,"error")}
      finally{cancelHostElection()}
    },HOST_GRACE_MS)
  }

  async function electHost() {
    const candidate = [...mp.players].sort((a,b)=>a.joinedAt-b.joinedAt||a.playerId.localeCompare(b.playerId))[0]?.playerId;
    if (!candidate) return;
    await runTransaction(ref(db, `rooms/${mp.roomId}/meta`), (meta) => meta && !mp.players.some((player)=>player.playerId===meta.hostId) ? { ...meta, hostId:candidate, hostEpoch:(Number(meta.hostEpoch)||0)+1 } : meta);
  }

  async function send(message) {
    if (!mp.roomId) return;
    if (message.type === "signal") return push(ref(db, `rooms/${mp.roomId}/signals/${message.to}`), { from:mp.playerId, data:message.data, createdAt:serverTimestamp() });
    if (message.type === "ready") return update(ref(db, `rooms/${mp.roomId}/players/${mp.playerId}`), { ready:!!message.ready, readyEpoch:mp.songEpoch, lastSeenAt:serverTimestamp() });
    if (message.type === "select-song" && mp.playerId===mp.hostId) return update(ref(db, `rooms/${mp.roomId}/meta`), { song:message.song, songEpoch:mp.songEpoch+1 });
    if (message.type === "transfer-host" && mp.playerId===mp.hostId) return update(ref(db, `rooms/${mp.roomId}/meta`), { hostId:message.to, hostEpoch:mp.hostEpoch+1 });
    if (message.type === "start" && mp.playerId===mp.hostId) {
      const allReady=mp.players.length>=2&&mp.players.every((player)=>player.ready&&Number(player.readyEpoch)===mp.songEpoch);
      if(!allReady)return status("仍有玩家尚未準備", "error");
      return set(ref(db, `rooms/${mp.roomId}/commands/start`), { id:crypto.randomUUID(), hostId:mp.playerId, hostEpoch:mp.hostEpoch, serverStartAt:Date.now()+mp.serverOffset+5000 });
    }
  }

  function reconcilePeers() {
    const ids = new Set(mp.players.map((player) => player.playerId).filter((id) => id !== mp.playerId));
    for (const id of ids) if (!mp.peers.has(id)) makePeer(id, mp.playerId < id);
    for (const id of mp.peers.keys()) if (!ids.has(id)) dropPeer(id);
  }

  function makePeer(peerId, initiator) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    const peer = { pc, channel: null, ping: null, openedAt: 0, pendingCandidates: [], stage:initiator?"建立Offer":"等待Offer" };
    mp.peers.set(peerId, peer);
    pc.onicecandidate = ({ candidate }) => { if(!candidate)return;peer.stage="交換ICE";renderPlayers();send({ type: "signal", to: peerId, data: { candidate:candidate.toJSON?.()||candidate } }).catch((error)=>{peer.stage=`ICE錯誤 ${error.message}`;renderPlayers()}) };
    pc.onconnectionstatechange = () => { peer.stage=`連線 ${pc.connectionState}`;if (["failed", "closed"].includes(pc.connectionState)) dropPeer(peerId); renderPlayers(); };
    pc.oniceconnectionstatechange=()=>{peer.stage=`ICE ${pc.iceConnectionState}`;renderPlayers()};
    pc.ondatachannel = ({ channel }) => attachChannel(peerId, channel);
    if (initiator) {
      attachChannel(peerId, pc.createDataChannel("drums", { ordered: false, maxRetransmits: 0 }));
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => send({ type: "signal", to: peerId, data: { description:pc.localDescription.toJSON?.()||pc.localDescription } })).catch((error)=>{peer.stage=`Offer錯誤 ${error.message}`;renderPlayers()});
    }
    renderPlayers();
  }

  async function receiveSignal(peerId, data) {
    if (!mp.peers.has(peerId)) makePeer(peerId, false);
    const { pc } = mp.peers.get(peerId);
    try {
      if (data.description) {
        mp.peers.get(peerId).stage=`收到${data.description.type}`;renderPlayers();
        await pc.setRemoteDescription(data.description);
        const peer = mp.peers.get(peerId);
        for (const candidate of peer.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
        if (data.description.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          send({ type: "signal", to: peerId, data: { description:pc.localDescription.toJSON?.()||pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else mp.peers.get(peerId).pendingCandidates.push(data.candidate);
      }
    } catch (error) { status(`直連協商失敗：${error.message}`, "error"); }
  }

  function attachChannel(peerId, channel) {
    const peer = mp.peers.get(peerId); if (!peer) return;
    peer.channel = channel;
    channel.onopen = () => { peer.openedAt = Date.now();peer.stage="DataChannel已開啟"; renderPlayers(); pingPeer(peerId); };
    channel.onclose = renderPlayers;
    channel.onmessage = ({ data }) => onPeer(peerId, JSON.parse(data));
  }

  function pingPeer(peerId) {
    const peer = mp.peers.get(peerId);
    if (!peer || peer.channel?.readyState !== "open") return;
    peer.channel.send(JSON.stringify({ type: "ping", at: performance.now() }));
    setTimeout(() => pingPeer(peerId), 2000);
  }

  function onPeer(peerId, message) {
    const peer = mp.peers.get(peerId);
    if (message.type === "ping") return peer?.channel?.send(JSON.stringify({ type: "pong", at: message.at }));
    if (message.type === "pong" && peer) { peer.ping = Math.round(performance.now() - message.at); renderPlayers(); return; }
    if (message.type === "hit") receiveHit(message);
  }

  function dropPeer(peerId) {
    const peer = mp.peers.get(peerId); if (!peer) return;
    try { peer.channel?.close(); peer.pc.close(); } catch {}
    mp.peers.delete(peerId); renderPlayers();
  }
  function closePeers() { for (const id of [...mp.peers.keys()]) dropPeer(id); }

  function renderPlayers() {
    $mp("#sdg-mp-players").innerHTML = mp.players.map((player) => {
      const self = player.playerId === mp.playerId;
      const peer = mp.peers.get(player.playerId);
      const direct = self || peer?.channel?.readyState === "open";
      const host = player.playerId === mp.hostId;
      const ready=player.ready&&Number(player.readyEpoch)===mp.songEpoch;
      return `<div class="sdg-mp-player"><span>${escapeHtml(player.name)} ${host?'<b class="sdg-mp-host">HOST</b>':''}</span><b class="${direct?'sdg-mp-ok':'sdg-mp-wait'}">${self?'本機':direct?`${peer.ping??'--'}ms`:escapeHtml(peer?.stage||'直連中')}</b><small>${ready?'✓ 已準備':'尚未準備'}${mp.playerId===mp.hostId&&!self?`　<button data-host="${player.playerId}">轉讓房主</button>`:''}</small></div>`;
    }).join("");
    $mp("#sdg-mp-players").querySelectorAll("[data-host]").forEach((button) => button.onclick = () => send({ type: "transfer-host", to: button.dataset.host }));
    $mp("#sdg-mp-song").disabled = mp.playerId !== mp.hostId;
    $mp("#sdg-mp-start").disabled = mp.playerId !== mp.hostId;
  }

  function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }

  async function chartHash() {
    const normalized = gameApi.state().chart.map(({ time_ms, lane, articulation, beat }) => [Math.round(time_ms), lane, articulation || "", Number(beat || 0).toFixed(5)]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(normalized)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function currentSongDescriptor() {
    const {chart,currentMeta,currentPart,songId,currentRevision,originalBpm,targetBpm,requestedPlaybackRate}=gameApi.state();
    if (!chart.length || !currentMeta || !Number.isInteger(currentPart)) throw Error("鼓譜尚未載入完成");
    const videoId = currentMeta.videos?.find((video) => video.status === "done" && video.videoId)?.videoId;
    return { songId, revisionId: currentRevision, partId: currentPart, instrumentId: 1024, youtubeVideoId: videoId, title: currentMeta.title, originalBpm, targetBpm, playbackRate: requestedPlaybackRate, noteCount: chart.length, chartHash: await chartHash(), url: `https://www.songsterr.com/a/wsa/song-drum-tab-s${songId}t${currentPart}/r${currentRevision}` };
  }

  async function verifyRoomSong() {
    if (!mp.song) return;
    const {chart,songId,currentRevision,currentPart}=gameApi.state();
    if (songId !== mp.song.songId || currentRevision !== mp.song.revisionId || currentPart !== mp.song.partId) {
      status(`房主選擇：${mp.song.title}，正在切換…`, "wait");
      await chrome.storage.local.set({ sdgMultiplayerResume: { roomId: mp.roomId, name: mp.name, savedAt: Date.now() } });
      location.href = mp.song.url;
      return;
    }
    if (!chart.length) return;
    const hash = await chartHash();
    if (hash !== mp.song.chartHash) return status("譜面雜湊不一致，無法準備", "error");
    gameApi.applyPlayback(mp.song);
    status(`譜面一致：${mp.song.title}`, "ok");
  }

  function allDirect() {
    return mp.players.filter((player) => player.playerId !== mp.playerId).every((player) => mp.peers.get(player.playerId)?.channel?.readyState === "open");
  }

  async function measureStartCompensation() {
    return gameApi.measureStartCompensation();
  }

  async function beginSynchronized(serverStartAt) {
    if (!allDirect()) return status("有人尚未完成直連，取消開始", "error");
    const localStartAt = serverStartAt - mp.serverOffset;
    status(`共同開始倒數 ${Math.max(0, (localStartAt-Date.now())/1000).toFixed(1)}秒`, "wait");
    const measured = await measureStartCompensation();
    if (Date.now() > localStartAt - 500) return status("啟動補償測量超時，請重新開始", "error");
    const fireAt = localStartAt - Math.max(0, measured.lastStartCompMs);
    gameApi.schedulePlayer(fireAt-Date.now());
    setTimeout(() => {
      gameApi.startOnline(`ONLINE · ${mp.roomId} · 補償 ${Math.round(measured.lastStartCompMs)}ms${measured.confirmed?'':'*'}`); status("合奏進行中", "ok");
    }, Math.max(0, localStartAt - Date.now()));
  }

  function broadcastHit(event) {
    if (!mp.roomId || !gameApi.isStarted()) return;
    const message = JSON.stringify({ type: "hit", ...event, senderId: mp.playerId, sequence: crypto.randomUUID() });
    for (const peer of mp.peers.values()) if (peer.channel?.readyState === "open") peer.channel.send(message);
  }

  function receiveHit(event) {
    if (!gameApi.isStarted() || !Number.isFinite(event.songTimeMs)) return;
    const localSongMs = gameApi.songTimeMs();
    const wait = event.songTimeMs - localSongMs;
    const play = () => gameApi.remoteHit(event);
    if (wait >= 0) setTimeout(play, wait / Math.max(.25, gameApi.state().actualPlaybackRate));
    else if (wait >= -LATE_LIMIT_MS) play();
    else gameApi.remoteFlash(event);
  }

  globalThis.__sdgMultiplayerHit = broadcastHit;
  $mp("#sdg-mp-create").onclick = () => createRoom().catch((error) => status(error.message, "error"));
  $mp("#sdg-mp-join").onclick = () => joinRoom().catch((error)=>status(error.message,"error"));
  $mp("#sdg-mp-leave").onclick = leaveRoom;
  $mp("#sdg-mp-song").onclick = async () => { try { const song = await currentSongDescriptor(); send({ type: "select-song", song }); } catch (error) { status(error.message, "error"); } };
  $mp("#sdg-mp-ready").onclick = async () => {
    if (!mp.song) return status("請先由房主選歌", "error");
    if (!allDirect()) return status("尚未完成所有玩家直連", "error");
    if ((await chartHash()) !== mp.song.chartHash) return status("譜面不一致", "error");
    const me = mp.players.find((player) => player.playerId === mp.playerId);
    const isReady=me?.ready&&Number(me.readyEpoch)===mp.songEpoch;
    send({ type: "ready", ready: !isReady });
  };
  $mp("#sdg-mp-start").onclick = () => send({ type: "start" });

  identity().then(async () => {
    const { sdgMultiplayerResume } = await chrome.storage.local.get("sdgMultiplayerResume");
    if (sdgMultiplayerResume?.roomId && Date.now() - sdgMultiplayerResume.savedAt < 30 * 60 * 1000) {
      panel.classList.remove("collapsed"); connect(sdgMultiplayerResume.roomId).catch((error)=>status(`重新連線失敗：${error.message}`,"error"));
    }
  });
})();
