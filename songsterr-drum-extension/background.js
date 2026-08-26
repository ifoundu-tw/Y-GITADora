const armedTabs=new Set();
let songsterrSoundfontBase64=null;
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type==='sdg-arm-auto-sync'&&sender.tab?.id){armedTabs.add(sender.tab.id);reply({ok:true});return}
  if(message?.type==='sdg-songsterr-soundfont'){
    (async()=>{
      try{
        if(!songsterrSoundfontBase64){
          const response=await fetch(message.url,{cache:'force-cache'});
          if(!response.ok)throw Error(`HTTP ${response.status}`);
          const bytes=new Uint8Array(await response.arrayBuffer());
          let binary='',chunk=32768;
          for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
          songsterrSoundfontBase64=btoa(binary);
        }
        reply({ok:true,base64:songsterrSoundfontBase64});
      }catch(error){reply({ok:false,error:error?.message||String(error)})}
    })();
    return true;
  }
});
chrome.action.onClicked.addListener(async tab=>{
  if(tab.id&&armedTabs.has(tab.id)&&/^https:\/\/www\.songsterr\.com\/a\/wsa\//.test(tab.url||'')){
    armedTabs.delete(tab.id);
    chrome.tabCapture.getMediaStreamId({targetTabId:tab.id,consumerTabId:tab.id},async streamId=>{const error=chrome.runtime.lastError?.message;await chrome.tabs.sendMessage(tab.id,{type:'sdg-auto-sync-granted',streamId,error}).catch(()=>{})});
    return;
  }
  const {playlist=[]}=await chrome.storage.local.get('playlist'),first=[...playlist].reverse().find(x=>x.youtubeVideoId);
  const tabs=await chrome.tabs.query({url:'https://www.youtube.com/watch*'}),existing=tabs.find(x=>(x.url||'').includes('sdg_drum_playlist=1')),url=`https://www.youtube.com/watch?v=${encodeURIComponent(first?.youtubeVideoId||'x1FV6IrjZCY')}&sdg_drum_playlist=1`;
  if(existing){await chrome.tabs.update(existing.id,{active:true});if(existing.windowId)await chrome.windows.update(existing.windowId,{focused:true})}else await chrome.tabs.create({url});
});
