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
  let context,synth,node,readyPromise,state='idle',lastError='';

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
  function resolveMidi(art,lane){
    if(art&&midiByArt[art]!=null)return midiByArt[art];
    if(art){
      const clean=art.replace(/-choke$/,'');
      if(midiByArt[clean]!=null)return midiByArt[clean];
    }
    return laneMidi[lane]??38;
  }
  function play(art,lane,intensity=.75,master=1,laneLevel=1){
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
  return{ensure,play,getState:()=>({state,error:lastError,url:FONT_URL})};
})();
