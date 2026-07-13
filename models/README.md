# 模型資料夾

遊戲視覺模型放這裡。**現役：YOLO11n-seg 輪廓分割模型（單類 person）**，
瀏覽器用 onnxruntime-web 跑（WebGPU 用 256、WASM 用 128）。

| 檔案 | 用途 |
|---|---|
| `seg_rN_256.onnx` / `seg_rN_128.onnx` | 線上遊戲用（`js/detector-seg.js` 的 SEG_HIRES/SEG_LORES 指向現役版本） |
| `seg_rN_192.onnx`、`seg_rN.pt` | 備用解析度與訓練權重（本機備份，不進 git） |
| `yolo11n-pose.*` | 已棄用（早期 pose 方案，現改輪廓分割） |

各輪成績（同一批 1,078 張 val，mask mAP50）：r2 0.907 → r3 0.934 → r4 0.946 → r5 0.952。
⚠️ 此分數與「雙老師自動標註」同源，屬相對指標；與 COCO 官方人工標註對比的
「真實成績單」見工作日誌 2026-07-13 之後的評測記錄。

## 訓練（於 DGX，容器 rtm_build，`~/rtm-outline/work/`）
- 標註管線：`autolabel2.py`（yolo11x-seg + SAM2 雙老師共識，可續跑）
- 資料集組裝：`mkdsN.py`；訓練：`yolo segment train model=yolo11n-seg.pt data=/work/dsN/data.yaml epochs=80 imgsz=256 batch=64 patience=20`
- 匯出：`yolo export format=onnx imgsz={256,192,128} opset=12`
- 詳細歷程見 `工作日誌/`。

> 註：`訓練資料/seg_r2_訓練成果/` 資料夾名為 r2，實際內容以資料夾內為準（歷史命名遺留）。
