(()=>{
if(!new URLSearchParams(location.search).has('sdg_drum_playlist')||window.__sdgPlayerBridge)return;window.__sdgPlayerBridge=true;
const root=document.documentElement;
function status(event,detail={}){root.dataset.sdgPlayerStatus=JSON.stringify({event,at:performance.now(),...detail});document.dispatchEvent(new Event('sdg-youtube-status'))}
function player(){return document.getElementById('movie_player')}
function run(command,attempt=0){let p=player();try{if(!p||typeof p.loadVideoById!=='function')throw Error('movie_player 尚未就緒');if(command.action==='load'){p.unMute?.();p.setVolume?.(70);p.loadVideoById({videoId:command.videoId,startSeconds:Number(command.startSeconds)||0});status('loadVideoById',{videoId:command.videoId,startSeconds:Number(command.startSeconds)||0})}else if(command.action==='pause'){p.pauseVideo?.();status('pause-command')}else if(command.action==='play'){p.unMute?.();p.setVolume?.(70);p.playVideo?.();status('play-command')}}catch(error){if(attempt<30)setTimeout(()=>run(command,attempt+1),100);else status('bridge-error',{error:error.message})}}
document.addEventListener('sdg-youtube-command',()=>{try{run(JSON.parse(root.dataset.sdgPlayerCommand||'{}'))}catch(error){status('command-error',{error:error.message})}});
status('bridge-ready');
})();
