/* Songsterr-compatible drum one-shot renderer. */
globalThis.SDGSongsterrSynth=(()=>{
  const FONT_URL='https://static.songsterr.com/midi-player-v0/SGM_Plus_HQ/128-000-21-08-26-0.sf3';
  const midiByArt={'acoustic-bass-drum':35,'bass-drum':36,'side-stick':37,snare:38,'electric-snare':40,'floor-tom':41,'very-low-tom':43,'low-tom':45,'mid-tom':47,'high-tom':50,'closed-hihat':42,'foot-hihat':44,'open-hihat':46,'half-hihat':92,'high-crash':49,'medium-crash':57,china:52,splash:55,ride:51,'ride-bell':53,'ride-edge':59,'ride-choke':94,'splash-choke':95,'china-choke':96,'high-crash-choke':97,'medium-crash-choke':98};
  const laneMidi={crash:49,hihat:42,hihat_pedal:44,snare:38,high_tom:50,bass_drum:36,medium_tom:47,floor_tom:41,ride:51};
  let context,liveSynth,liveNode,renderer,rendererSoundfontId,outputBus,limiter,fontBuffer,rendererPromise,limiterOn=true,limiterCeiling=-1,readyPromise,state='idle',lastError='',songKey='',songState='none',samplePools=new Map();
  const activeVoices=new Map();
  function decodeBase64(value){const raw=atob(value),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes.buffer}
  function quantizeVelocity(value){const v=Math.max(1,Math.min(127,Math.round(Number(value)||96)));return Math.max(16,Math.min(127,Math.round(v/16)*16))}
  function resolveMidi(art,lane,midi){if(midi!==null&&midi!==undefined&&midi!==''&&Number.isFinite(Number(midi)))return Number(midi);if(art&&midiByArt[art]!=null)return midiByArt[art];if(art&&midiByArt[art.replace(/-choke$/,'')]!=null)return midiByArt[art.replace(/-choke$/,'')];return laneMidi[lane]??38}
  function renderDuration(art,midi){if(/crash|china|splash|ride/.test(art||'')||[49,51,52,53,55,57,59,93,94,95,96,97,98].includes(midi))return 3.2;if(/open-hihat|half-hihat/.test(art||'')||[46,92].includes(midi))return 1.5;if(/closed-hihat|foot-hihat/.test(art||'')||[42,44].includes(midi))return .55;return 1.05}
  async function ensure(){
    if(state==='ready')return true;if(readyPromise)return readyPromise;state='loading';
    readyPromise=(async()=>{
      if(!globalThis.JSSynth)throw Error('FluidSynth 核心未載入');await globalThis.JSSynth.waitForReady();globalThis.JSSynth.disableLogging?.();
      context=context||new AudioContext({latencyHint:'interactive'});await context.resume();
      if(!outputBus){outputBus=context.createGain();limiter=context.createDynamicsCompressor();limiter.knee.value=1;limiter.ratio.value=20;limiter.attack.value=.001;limiter.release.value=.045;applyOutputSettings()}
      const response=await chrome.runtime.sendMessage({type:'sdg-songsterr-soundfont',url:FONT_URL});if(!response?.ok)throw Error(response?.error||'Songsterr 鼓音色下載失敗');fontBuffer=decodeBase64(response.base64);
      liveSynth=new globalThis.JSSynth.Synthesizer();liveSynth.init(context.sampleRate,{polyphony:512});liveSynth.setGain(1.2);const liveFontId=await liveSynth.loadSFont(fontBuffer.slice(0));liveSynth.setChannelType(9,true);liveSynth.midiProgramSelect(9,liveFontId,128,0);liveNode=liveSynth.createAudioNode(context,512);liveNode.connect(outputBus);
      state='ready';lastError='';return true
    })().catch(error=>{state='error';lastError=error?.message||String(error);readyPromise=null;try{liveNode?.disconnect();liveSynth?.close()}catch{}liveNode=null;liveSynth=null;throw error});return readyPromise
  }
  async function ensureRenderer(){
    await ensure();if(renderer)return true;if(rendererPromise)return rendererPromise;rendererPromise=(async()=>{renderer=new globalThis.JSSynth.Synthesizer();renderer.init(context.sampleRate,{polyphony:1024,reverbActive:false,chorusActive:false});renderer.setGain(1.2);rendererSoundfontId=await renderer.loadSFont(fontBuffer.slice(0));renderer.setChannelType(9,true);renderer.midiProgramSelect(9,rendererSoundfontId,128,0);return true})().catch(error=>{try{renderer?.close()}catch{}renderer=null;rendererPromise=null;throw error});return rendererPromise
  }
  function trimRendered(left,right){const threshold=.00005,sr=context.sampleRate;let first=0,last=left.length-1;while(first<left.length&&Math.max(Math.abs(left[first]),Math.abs(right[first]))<threshold)first++;while(last>first&&Math.max(Math.abs(left[last]),Math.abs(right[last]))<threshold)last--;first=Math.max(0,first-Math.floor(sr*.003));last=Math.min(left.length-1,last+Math.floor(sr*.035));const length=Math.max(Math.floor(sr*.08),last-first+1),buffer=context.createBuffer(2,length,sr);buffer.copyToChannel(left.subarray(first,Math.min(left.length,first+length)),0);buffer.copyToChannel(right.subarray(first,Math.min(right.length,first+length)),1);return buffer}
  function renderOneShot(midi,velocity,art){
    renderer.midiAllSoundsOff(-1);renderer.midiSystemReset();renderer.setChannelType(9,true);renderer.midiProgramSelect(9,rendererSoundfontId,128,0);renderer.midiNoteOn(9,midi,velocity);
    const frames=Math.ceil(renderDuration(art,midi)*context.sampleRate),left=new Float32Array(frames),right=new Float32Array(frames),chunk=1024,noteOffFrame=Math.floor(context.sampleRate*.06);let noteOffSent=false;
    for(let offset=0;offset<frames;offset+=chunk){const size=Math.min(chunk,frames-offset),block=[new Float32Array(size),new Float32Array(size)];renderer.render(block);left.set(block[0],offset);right.set(block[1],offset);if(!noteOffSent&&offset+size>=noteOffFrame){renderer.midiNoteOff(9,midi);noteOffSent=true}}
    renderer.midiAllSoundsOff(-1);return trimRendered(left,right)
  }
  async function loadSong({songId,revisionId,partId,notes}){
    const key=`${songId}/${revisionId}/${partId}`;if(songKey===key&&songState==='ready')return{key,pools:samplePools.size};await ensureRenderer();songKey=key;songState='loading';samplePools=new Map();
    try{const requests=new Map();for(const note of notes||[]){const midi=resolveMidi(note.articulation,note.lane,note.midi),velocity=quantizeVelocity(note.velocity),id=`${midi}:${velocity}`;if(!requests.has(id))requests.set(id,{midi,velocity,art:note.articulation})}for(const [lane,midi] of Object.entries(laneMidi)){const id=`${midi}:96`;if(!requests.has(id))requests.set(id,{midi,velocity:96,art:null,lane})}
      let rendered=0;for(const request of requests.values()){const buffer=renderOneShot(request.midi,request.velocity,request.art),layers=samplePools.get(request.midi)||[];layers.push({velocity:request.velocity,buffer});samplePools.set(request.midi,layers);if(++rendered%4===0)await new Promise(resolve=>setTimeout(resolve,0))}for(const layers of samplePools.values())layers.sort((a,b)=>a.velocity-b.velocity);songState='ready';lastError='';return{key,pools:samplePools.size,layers:rendered}
    }catch(error){songState='error';lastError=error?.message||String(error);throw error}
  }
  function voiceGroup(art,lane){if(/open-hihat|half-hihat/.test(art||''))return'hihat-open';if(/closed-hihat/.test(art||''))return'hihat-closed';if(/foot-hihat/.test(art||'')||lane==='hihat_pedal')return'hihat-pedal';if(/high-crash/.test(art||''))return'crash-high';if(/medium-crash/.test(art||''))return'crash-medium';if(/china/.test(art||''))return'crash-china';if(/splash/.test(art||''))return'crash-splash';if(/ride/.test(art||''))return'ride';return lane||art||'drum'}
  function rememberVoice(group,source,gain){const voice={source,gain},voices=activeVoices.get(group)||[];voices.push(voice);activeVoices.set(group,voices);source.onended=()=>{const current=activeVoices.get(group)||[],next=current.filter(x=>x!==voice);if(next.length)activeVoices.set(group,next);else activeVoices.delete(group)}}
  function stopGroup(group,seconds=.025){const now=context?.currentTime||0;for(const voice of activeVoices.get(group)||[])try{voice.gain.gain.cancelScheduledValues(now);voice.gain.gain.setValueAtTime(Math.max(.0001,voice.gain.gain.value),now);voice.gain.gain.exponentialRampToValueAtTime(.0001,now+seconds);voice.source.stop(now+seconds+.006)}catch{}activeVoices.delete(group)}
  function applyChoke(art,lane){if(/closed-hihat|foot-hihat/.test(art||'')||lane==='hihat_pedal')stopGroup('hihat-open');if(/-choke$/.test(art||''))stopGroup(voiceGroup(art.replace(/-choke$/,''),lane),.018)}
  function applyOutputSettings(){if(!outputBus||!context)return;try{outputBus.disconnect();limiter?.disconnect()}catch{}if(limiterOn){limiter.threshold.value=limiterCeiling;outputBus.connect(limiter).connect(context.destination)}else outputBus.connect(context.destination)}
  function configure(options={}){if(typeof options.limiterEnabled==='boolean')limiterOn=options.limiterEnabled;if(Number.isFinite(Number(options.limiterCeilingDb)))limiterCeiling=Math.max(-6,Math.min(0,Number(options.limiterCeilingDb)));applyOutputSettings();return{limiterEnabled:limiterOn,limiterCeilingDb:limiterCeiling}}
  function play(art,lane,intensity=.75,master=1,laneLevel=1,noteTime=null,midiValue=null,velocityValue=null){
    if(state!=='ready'){ensure().catch(()=>{});return false}context.resume();applyChoke(art,lane);const midi=resolveMidi(art,lane,midiValue),velocity=quantizeVelocity(velocityValue??127*intensity),layers=samplePools.get(midi);
    if(songState==='ready'&&layers?.length){const layer=layers.reduce((best,item)=>Math.abs(item.velocity-velocity)<Math.abs(best.velocity-velocity)?item:best,layers[0]),source=context.createBufferSource(),gain=context.createGain();source.buffer=layer.buffer;gain.gain.value=Math.max(.0001,1.8*master*laneLevel);source.connect(gain).connect(outputBus);rememberVoice(voiceGroup(art,lane),source,gain);source.start(context.currentTime);return true}
    liveSynth.midiNoteOn(9,midi,Math.max(1,Math.min(127,Math.round(velocity*master*laneLevel))));setTimeout(()=>{try{liveSynth?.midiNoteOff(9,midi)}catch{}},60);return true
  }
  function playLive(art,lane,intensity=.75,master=1,laneLevel=1,midiValue=null,velocityValue=null){
    if(state!=='ready'){ensure().catch(()=>{});return false}context.resume();const midi=resolveMidi(art,lane,midiValue),velocity=quantizeVelocity(velocityValue??127*intensity),level=Math.max(0,master*laneLevel),value=Math.max(1,Math.min(127,Math.round(velocity*level)));liveSynth.midiNoteOn(9,midi,value);setTimeout(()=>{try{liveSynth?.midiNoteOff(9,midi)}catch{}},60);return true
  }
  return{ensure,loadSong,play,playLive,configure,getState:()=>({state,songState,songKey,error:lastError,url:FONT_URL,pools:samplePools.size,limiterEnabled:limiterOn,limiterCeilingDb:limiterCeiling})};
})();
