const armedTabs=new Set();
chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message?.type==='sdg-arm-auto-sync'&&sender.tab?.id){armedTabs.add(sender.tab.id);reply({ok:true})}});
chrome.runtime.onMessage.addListener(async message=>{if(message?.type!=='sdg-open-playlist-manager')return;const url=chrome.runtime.getURL('playlist.html'),tabs=await chrome.tabs.query({url});if(tabs[0])await chrome.tabs.update(tabs[0].id,{active:true});else await chrome.tabs.create({url})});
chrome.action.onClicked.addListener(async tab=>{
  if(tab.id&&armedTabs.has(tab.id)&&/^https:\/\/www\.songsterr\.com\/a\/wsa\//.test(tab.url||'')){
    armedTabs.delete(tab.id);
    chrome.tabCapture.getMediaStreamId({targetTabId:tab.id,consumerTabId:tab.id},async streamId=>{const error=chrome.runtime.lastError?.message;await chrome.tabs.sendMessage(tab.id,{type:'sdg-auto-sync-granted',streamId,error}).catch(()=>{})});
    return;
  }
  const {playlist=[]}=await chrome.storage.local.get('playlist'),first=[...playlist].reverse().find(x=>x.youtubeVideoId);
  if(!first){const url=chrome.runtime.getURL('playlist.html'),tabs=await chrome.tabs.query({url});if(tabs[0])await chrome.tabs.update(tabs[0].id,{active:true});else await chrome.tabs.create({url});return}
  const tabs=await chrome.tabs.query({url:'https://www.youtube.com/watch*'}),existing=tabs.find(x=>(x.url||'').includes('sdg_drum_playlist=1')),url=`https://www.youtube.com/watch?v=${encodeURIComponent(first.youtubeVideoId)}&sdg_drum_playlist=1`;
  if(existing){await chrome.tabs.update(existing.id,{active:true});if(existing.windowId)await chrome.windows.update(existing.windowId,{focused:true})}else await chrome.tabs.create({url});
});
