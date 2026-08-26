# Songsterr Drum Game 擴充功能

## 備份與相容性

播放清單頁提供「匯出備份」與「匯入備份」。JSON 備份包含格式識別、結構版本、匯出時間及插件版本；匯入採合併方式，保留現有與未來新增欄位。較新版格式不會被舊版插件強行匯入。

1. Chrome 開啟 `chrome://extensions`。
2. 開啟「開發人員模式」。
3. 按「載入未封裝項目」，選擇本資料夾。
4. 點工具列擴充功能，輸入 Songsterr 網址並加入播放清單。
5. 點清單歌曲，在 Songsterr 先親自點一次「原聲」播放；偵測到播放器後會進入遊戲。

按鍵：Z Hi-Hat、X Crash、C Snare、V High Tom、B Floor Tom、N Medium Tom、M Bass Drum、`<` Ride、P 暫停。

遊戲左側可重新綁定每一軌按鍵，並用左右箭頭調整軌道順序。上方可分別調整按鍵音效與音樂音量；設定會自動保存在 Chrome 本機。

按鍵音使用 CC0 Virtuosity Drums 真實取樣。左側每一軌另有獨立音量滑桿；實際輸出音量為「按鍵總音量 × 該軌音量」。授權與來源見 `THIRD_PARTY_NOTICES.md`。

本版直接在 Songsterr 頁面執行，因此共用該頁獲准播放的 YouTube 原聲，不從 localhost 重新嵌入影片。
