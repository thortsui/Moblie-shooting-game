# 🔫 Phone Gun Fight — 手機 AR 槍戰

用手機鏡頭 + 瀏覽器本地姿態偵測玩的 AR 槍戰網頁遊戲。目前為**單機試作版**：鏡頭裡的每個人都是靶，頭上有血條，打倒後 5 秒重生。

## 玩法（試作版）
- 直式握持手機，十字標對準人開火
- 軀幹 -25 HP／爆頭 -50 HP（滿血 100）
- 每槍冷卻 1 秒
- 打倒後 5 秒重生

## 線上遊玩（GitHub Pages）
1. Repo 的 **Settings → Pages → Source 選 `main` branch / root** 儲存
2. 幾分鐘後用手機開 `https://thortsui.github.io/Moblie-shooting-game/`
3. 允許相機權限即可（Pages 自帶 HTTPS，鏡頭才打得開）

## 本地開發
```
npx http-server -p 8777
# 開 http://localhost:8777（localhost 免 HTTPS 可開鏡頭）
```

## 架構
| 檔案 | 職責 |
|---|---|
| `js/detector.js` | 視覺抽象層：MoveNet MultiPose（TF.js）+ 頭/軀幹命中幾何。之後可換 YOLOv8-pose ONNX，介面不變 |
| `js/game.js` | 遊戲規則:血量、傷害、冷卻、重生、WebAudio 合成音效 |
| `js/main.js` | 相機、偵測/渲染雙迴圈、座標轉換、HUD、觸控輸入 |

## 開發路線
- [x] 單機試作：相機 + 多人姿態偵測 + 命中判定 + 頭上血條
- [ ] 手機實測效能（目標 15+ FPS）
- [ ] 玩家顏色登錄與識別
- [ ] PeerJS 房間系統（房主為 hub，收發扣血訊息）
- [ ] 勝利條件與結算畫面

規格詳見 [docs/使用者故事.md](docs/使用者故事.md)。
