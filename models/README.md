# 模型資料夾

遊戲視覺模型放這裡。目前檔案（皆未進 git，見 `.gitignore`）：

| 檔案 | 用途 | 來源 |
|---|---|---|
| `yolo11n-pose.pt` | **訓練用**權重（fine-tune 的暖啟動起點） | 官方預訓練，2026-07-12 於 DGX 下載 |
| `yolo11n-pose.onnx` | **瀏覽器推論用**（imgsz 256, opset 12） | 由上者 `yolo export` 匯出 |

整合狀態：**尚未接進遊戲**。目前遊戲用的是 MoveNet MultiPose（`js/detector.js`）。ONNX 待接 onnxruntime-web 後才會實際使用。

---

## 日後訓練這隻 pose YOLO（在 DGX 上）

前置：連線與環境見專案根目錄 `DGX連線與使用手冊.md`。DGX = `ethan@192.168.0.126`，容器 `yolo11-spark:latest`。

### 1. 準備資料集（人體姿態標註）
- 用遊戲手機視角拍玩家照片/影片，涵蓋不同光線、距離、角度、服裝。
- 標註人體 17 個 COCO 關鍵點（Roboflow / CVAT）。輸出 YOLO pose 格式 + `data.yaml`。

### 2. 推上 DGX 並訓練（暖啟動用這隻 .pt）
```bash
# 資料夾示意：~/pose-train/{images,labels,data.yaml}
ssh -i ~/.ssh/dgx_claude ethan@192.168.0.126 \
  "docker run -d --gpus all --shm-size=8g -v ~/pose-train:/work --name pose_train \
   yolo11-spark:latest \
   yolo pose train model=/work/yolo11n-pose.pt data=/work/data.yaml \
   epochs=100 imgsz=256 batch=16 patience=20 project=/work/runs name=pose_r1 exist_ok=True"
```
- 訓練前若 GPU 記憶體吃緊，先停 qwen：`docker stop vllm-qwen3.5-35b-a3b-nvfp4`，訓完再 `docker start`。
- nano 模型很小，多半不必停 qwen。

### 3. 匯出並抓回
```bash
# 匯出 ONNX
ssh -i ~/.ssh/dgx_claude ethan@192.168.0.126 \
  "docker run --rm -v ~/pose-train:/work -w /work yolo11-spark:latest \
   yolo export model=/work/runs/pose_r1/weights/best.pt format=onnx imgsz=256 opset=12"
# 抓回覆蓋
scp -i ~/.ssh/dgx_claude \
  "ethan@192.168.0.126:~/pose-train/runs/pose_r1/weights/best.onnx" \
  "D:/Documents/ThorWorkSpace/Phone gun fight/models/yolo11n-pose.onnx"
```

> ⚠️ 本檔的訓練指令沿用 Minecraft 專案的 DGX 環境，但**資料與 runs 放在獨立的 `~/pose-train/`**，不動 `~/mc-yolo-all/` 等既有訓練。
