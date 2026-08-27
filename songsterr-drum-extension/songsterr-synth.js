/* Songsterr-compatible drum synth mode.
 * Engine: FluidSynth (LGPL) through js-synthesizer (BSD-3-Clause).
 * SoundFont is fetched at runtime from Songsterr and is not redistributed.
 */
globalThis.SDGSongsterrSynth=(()=>{
  const FONT_URL='https://static.songsterr.com/midi-player-v0/SGM_Plus_HQ/128-000-21-08-26-0.sf3';
  const midiByArt={
    'acoustic-bass-drum':35,'bass-drum':36,'side-stick':37,snare:38,'electric-snare':40,
    'floor-tom':41,'very-low-tom':43,'low-tom':45,'mid-tom':47,'high-tom':50,
    'closed-hihat':42,'foot-hihat':44,'open-hihat':46,'half-hihat':92,
    'high-crash':49,'medium-crash':57,china:52,splash:55,
    ride:51,'ride-bell':53,'ride-edge':59,
    'ride-choke':94,'splash-choke':95,'china-choke':96,'high-crash-choke':97,'medium-crash-choke':98
  };
  const laneMidi={crash:49,hihat:42,hihat_pedal:44,snare:38,high_tom:50,bass_drum:36,medium_tom:47,floor_tom:41,ride:51};
  let context,synth,node,songBus,songLimiter,readyPromise,state='idle',lastError='',songKey='',songState='none';
  let songPools={},songBuffer=null;
  const activeVoices=new Map();

  function decodeBase64(value){
    const raw=atob(value),bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    return bytes.buffer;
  }
  async function ensure(){
    if(state==='ready')return true;
    if(readyPromise)return readyPromise;
    state='loading';
    readyPromise=(async()=>{
      if(!globalThis.JSSynth)throw Error('FluidSynth 核心未載入');
      await globalThis.JSSynth.waitForReady();
      globalThis.JSSynth.disableLogging?.();
      context=context||new AudioContext({latencyHint:'interactive'});
      await context.resume();
      if(!songBus){
        songBus=context.createGain();songLimiter=context.createDynamicsCompressor();
        // Songsterr keeps drum voices polyphonic.  This stage is only a fast
        // safety ceiling; it must recover before the next 16th-note hit.
        songLimiter.threshold.value=-1.5;songLimiter.knee.value=1;songLimiter.ratio.value=20;songLimiter.attack.value=.001;songLimiter.release.value=.045;
        songBus.connect(songLimiter).connect(context.destination);
      }
      synth=new globalThis.JSSynth.Synthesizer();
      synth.init(context.sampleRate);
      synth.setGain(1.2);
      node=synth.createAudioNode(context,1024);
      node.connect(context.destination);
      const response=await chrome.runtime.sendMessage({type:'sdg-songsterr-soundfont',url:FONT_URL});
      if(!response?.ok)throw Error(response?.error||'Songsterr 鼓音色下載失敗');
      const soundfontId=await synth.loadSFont(decodeBase64(response.base64));
      synth.setChannelType(9,true);
      synth.midiProgramSelect(9,soundfontId,128,0);
      state='ready';lastError='';
      return true;
    })().catch(error=>{
      state='error';lastError=error?.message||String(error);readyPromise=null;
      try{node?.disconnect();synth?.close()}catch{}
      node=null;synth=null;
      throw error;
    });
    return readyPromise;
  }
  function sampleDuration(art){
    if(/crash|china|splash|ride/.test(art||''))return 2.4;
    if(/open-hihat|half-hihat/.test(art||''))return 1.1;
    if(/closed-hihat|foot-hihat/.test(art||''))return .34;
    return .62;
  }
  function makeSlice(source,startSec,durationSec){
    const start=Math.max(0,Math.floor(startSec*source.sampleRate));
    const length=Math.max(1,Math.min(source.length-start,Math.floor(durationSec*source.sampleRate)));
    const out=context.createBuffer(source.numberOfChannels,length,source.sampleRate),fade=Math.min(length,Math.floor(source.sampleRate*.025));
    for(let ch=0;ch<source.numberOfChannels;ch++){
      const data=new Float32Array(length);source.copyFromChannel(data,ch,start);
      for(let i=0;i<fade;i++)data[length-fade+i]*=1-i/fade;
      out.copyToChannel(data,ch);
    }
    return out;
  }
  function rememberVoice(group,source,gain){
    const voice={source,gain},voices=activeVoices.get(group)||[];
    voices.push(voice);activeVoices.set(group,voices);
    source.onended=()=>{
      const current=activeVoices.get(group)||[],next=current.filter(x=>x!==voice);
      if(next.length)activeVoices.set(group,next);else activeVoices.delete(group);
    };
  }
  function stopGroup(group,seconds=.025){
    const now=context?.currentTime||0;
    for(const voice of activeVoices.get(group)||[]){
      try{
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(Math.max(.0001,voice.gain.gain.value),now);
        voice.gain.gain.exponentialRampToValueAtTime(.0001,now+seconds);
        voice.source.stop(now+seconds+.006);
      }catch{}
    }
    activeVoices.delete(group);
  }
  function voiceGroup(art,lane){
    if(/open-hihat|half-hihat/.test(art||''))return'hihat-open';
    if(/closed-hihat/.test(art||''))return'hihat-closed';
    if(/foot-hihat/.test(art||'')||lane==='hihat_pedal')return'hihat-pedal';
    if(/high-crash/.test(art||''))return'crash-high';
    if(/medium-crash/.test(art||''))return'crash-medium';
    if(/china/.test(art||''))return'crash-china';
    if(/splash/.test(art||''))return'crash-splash';
    if(/ride/.test(art||''))return'ride';
    return lane||art||'drum';
  }
  function applyChoke(art,lane){
    if(/closed-hihat|foot-hihat/.test(art||'')||lane==='hihat_pedal')stopGroup('hihat-open');
    if(!/-choke$/.test(art||''))return;
    const clean=art.replace(/-choke$/,''),group=voiceGroup(clean,lane);
    stopGroup(group,.018);
  }
  function transientStats(source,timeMs){
    const start=Math.max(1,Math.floor((timeMs/1000-.004)*source.sampleRate)),length=Math.min(Math.floor(source.sampleRate*.12),source.length-start);
    let energy=0,difference=0,peak=0,previous=0;
    for(let i=0;i<length;i++){
      let value=0;
      for(let ch=0;ch<source.numberOfChannels;ch++)value+=source.getChannelData(ch)[start+i];
      value/=source.numberOfChannels;
      const absolute=Math.abs(value);energy+=absolute;difference+=Math.abs(value-previous);peak=Math.max(peak,absolute);previous=value;
    }
    return{brightness:difference/Math.max(.000001,energy),peak};
  }
  function buildSongPools(notes,buffer){
    const pools={},sorted=notes.filter(n=>Number.isFinite(n.synth_time_ms)).slice().sort((a,b)=>a.synth_time_ms-b.synth_time_ms);
    for(let note of sorted){
      const art=note.articulation||'',duration=sampleDuration(art),t=note.synth_time_ms;
      const same=sorted.filter(x=>x!==note&&Math.abs(x.synth_time_ms-t)<12).length;
      const previous=[...sorted].reverse().find(x=>x.synth_time_ms<t-12),next=sorted.find(x=>x.synth_time_ms>t+12);
      const prevGap=previous?(t-previous.synth_time_ms)/1000:9,nextGap=next?(next.synth_time_ms-t)/1000:9;
      const stats=transientStats(buffer,t),bassPenalty=note.lane==='bass_drum'?stats.brightness*1000+(stats.peak<.015?120:0):0;
      const score=same*100+(prevGap<.025?100:0)+(nextGap<duration+.03?100:0)-Math.min(prevGap,3)-Math.min(nextGap,3)+bassPenalty;
      (pools[art]??=[]).push({note,score,prevGap,nextGap});
      (pools[`lane:${note.lane}`]??=[]).push({note,score:score+25,prevGap,nextGap});
    }
    const rendered={};
    for(let [key,candidates] of Object.entries(pools)){
      // A one-shot must contain its complete natural tail.  Reject crowded
      // donors instead of cutting them to the next chart event; FluidSynth is
      // the safe fallback when the rendered stem has no isolated hit.
      const chosen=candidates.sort((a,b)=>a.score-b.score)
        .filter(x=>x.prevGap>=.025&&x.nextGap>=sampleDuration(x.note.articulation)+.03)
        .filter((x,i,a)=>a.findIndex(y=>Math.abs(y.note.synth_time_ms-x.note.synth_time_ms)<250)===i).slice(0,3);
      if(chosen.length)rendered[key]=chosen.map(({note})=>makeSlice(buffer,note.synth_time_ms/1000-.006,sampleDuration(note.articulation)));
    }
    return rendered;
  }
  async function loadSong({songId,revisionId,audioHash,partId,notes}){
    const key=`${songId}/${revisionId}/${audioHash}/${partId}`;
    if(songKey===key&&songState==='ready')return{key,pools:Object.keys(songPools).length};
    await ensure();songKey=key;songState='loading';songPools={};songBuffer=null;
    try{
      if(!audioHash)throw Error('此修訂沒有 Songsterr V4 合成音訊');
      const url=`https://audio4-1.songsterr.com/${songId}/${revisionId}/${audioHash}/100/s/${partId}.opus`;
      const response=await chrome.runtime.sendMessage({type:'sdg-songsterr-audio',url});
      if(!response?.ok)throw Error(response?.error||'歌曲合成鼓軌下載失敗');
      songBuffer=await context.decodeAudioData(decodeBase64(response.base64));
      const duration=songBuffer.duration;
      songPools=buildSongPools(notes||[],songBuffer);songBuffer=null;songState='ready';lastError='';
      return{key,pools:Object.keys(songPools).length,duration};
    }catch(error){songState='error';lastError=error?.message||String(error);throw error}
  }
  function resolveMidi(art,lane){
    if(art&&midiByArt[art]!=null)return midiByArt[art];
    if(art){
      const clean=art.replace(/-choke$/,'');
      if(midiByArt[clean]!=null)return midiByArt[clean];
    }
    return laneMidi[lane]??38;
  }
  function play(art,lane,intensity=.75,master=1,laneLevel=1,noteTime=null){
    applyChoke(art,lane);
    if(songState==='ready'){
      const pool=songPools[art]||songPools[`lane:${lane}`];
      if(pool?.length){
        const buffer=pool[Math.floor(Math.random()*pool.length)],source=context.createBufferSource(),gain=context.createGain();
        source.buffer=buffer;
        // The rendered Songsterr stem already contains note velocity. Do not apply
        // chart intensity a second time. 2.2x restores the perceived level of the
        // full synth mix; the limiter controls dense rolls and simultaneous hits.
        gain.gain.value=Math.max(.0001,2.2*master*laneLevel);source.connect(gain).connect(songBus);
        rememberVoice(voiceGroup(art,lane),source,gain);source.start();
        return true;
      }
    }
    if(state!=='ready'){
      ensure().catch(()=>{});
      return false;
    }
    context.resume();
    const midi=resolveMidi(art,lane);
    const velocity=Math.max(1,Math.min(127,Math.round(127*intensity*master*laneLevel)));
    synth.midiNoteOn(9,midi,velocity);
    setTimeout(()=>{try{synth?.midiNoteOff(9,midi)}catch{}},40);
    return true;
  }
  return{ensure,loadSong,play,getState:()=>({state,songState,songKey,error:lastError,url:FONT_URL,pools:Object.keys(songPools).length})};
})();
