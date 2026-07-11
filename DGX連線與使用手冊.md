# DGX 連線與使用手冊(可搬走版)

> **這份文件是給「任何一台電腦上的 AI(或人)」看的接手手冊。**
> 只要照這份做,就能連上家裡的 DGX、啟動 AI 大腦、跑模型訓練。
> 換電腦、換對話、換 AI 都適用 —— 唯一要另外搬的東西是 **SSH 私鑰檔**(見第 2 節)。
>
> 最後驗證日期:2026-07-12(當天實測連線成功、qwen 容器 healthy)。

---

## 1. DGX 是哪台機器

| 項目 | 內容 |
|---|---|
| 機型 | NVIDIA **DGX Spark**(hostname:`spark-7879`) |
| 區網 IP | **`192.168.0.126`**(需和它在同一個 WiFi/區網) |
| 登入帳號 | `ethan` |
| 晶片 | GB10(Grace-Blackwell),**~128GB 統一記憶體**(CPU/GPU 共用) |
| CPU 架構 | **ARM(aarch64)**⚠ 不是一般 x86,裝 Python 套件要注意 |
| 系統 | Ubuntu Linux;**所有 AI 工作都在 Docker 容器裡跑**(免 sudo) |
| 磁碟 | 3.7TB(2026-06 時約剩 2.5TB) |

**它負責什麼:**
1. **跑 AI 大腦**(qwen 多模態模型,給 Minecraft bot 看圖決策用)
2. **跑模型訓練**(YOLO 視覺模型,筆電 4060 太弱訓不動的都搬來這)

筆電只做「推論 + 玩遊戲 + 收資料」,訓練一律上 DGX。

---

## 2. 怎麼連上(含換電腦搬家步驟)

### 2-1. 連線指令(金鑰已設好的電腦)

```bash
ssh -i ~/.ssh/dgx_claude ethan@192.168.0.126
```

免密碼。跑單一指令不進互動模式:

```bash
ssh -i ~/.ssh/dgx_claude ethan@192.168.0.126 "hostname && docker ps"
```

### 2-2. 金鑰檔在哪(⚠搬家必帶,不在 git 裡)

| 檔案 | 位置(目前這台筆電) |
|---|---|
| 私鑰(祕密,絕不外流) | `C:\Users\ethan\.ssh\dgx_claude` |
| 公鑰 | `C:\Users\ethan\.ssh\dgx_claude.pub`(註解 `claude-dgx-training`) |

**換到新電腦的步驟:**
1. 把上面兩個檔案複製到新電腦的 `~/.ssh/`(Windows 是 `C:\Users\<你>\.ssh\`)。用隨身碟或區網分享搬,**不要**上傳到雲端/git。
2. (Linux/Mac 才需要)`chmod 600 ~/.ssh/dgx_claude`。
3. 測試:`ssh -i ~/.ssh/dgx_claude ethan@192.168.0.126 hostname` → 回 `spark-7879` 就成功。

**拿不到舊私鑰時(重新配一把):**
1. 新電腦產金鑰:`ssh-keygen -t ed25519 -f ~/.ssh/dgx_claude -N ""`
2. 把 `dgx_claude.pub` 的內容,加到 DGX 上的 `~/.ssh/authorized_keys`(這步要打一次 DGX 密碼,或請已能連線的電腦幫忙加)。
3. 之後就免密碼了。

### 2-3. 連線失敗排查

- `ping 192.168.0.126` 不通 → 不在同一區網,或 DGX 沒開機。
- ping 得到但 ssh 被拒 → 金鑰沒放對位置 / 沒加進 authorized_keys。
- **安全規則:DGX 密碼不寫進任何檔案或對話。** 一律走金鑰。

---

## 3. 常用速查指令(都從自己電腦遠端跑)

```bash
# 縮寫:以下用 $DGX 代表 ssh -i ~/.ssh/dgx_claude ethan@192.168.0.126

# 看 GPU / 記憶體狀態
$DGX "nvidia-smi"

# 看有哪些容器在跑
$DGX "docker ps --format '{{.Names}}: {{.Status}}'"

# 看磁碟剩多少
$DGX "df -h /"

# 看某容器最新輸出(例:訓練進度)
$DGX "docker logs --tail 5 yolo_train"
```

---

## 4. AI 大腦(qwen)— 啟動 / 停止 / 檢查

DGX 上跑一個多模態大模型當 bot 的「大腦」,筆電的 `brain.py`、`control_server.py` 都連它。

| 項目 | 內容 |
|---|---|
| 目前模型 | **Qwen3.5-35B-A3B-NVFP4**(會看圖 + 工具呼叫 + 推論) |
| 容器名 | `vllm-qwen3.5-35b-a3b-nvfp4` |
| 服務埠 | **8101**(OpenAI 相容 API,`http://192.168.0.126:8101/v1`) |
| 專案位置(DGX 上) | `~/projects/Qwen3.5-35B-A3B/` |

```bash
# 檢查大腦活著沒(在 DGX 上跑,或筆電 curl 192.168.0.126:8101)
$DGX "curl -s localhost:8101/v1/models"

# 啟動(平常用 docker start 就好,容器已建過)
$DGX "docker start vllm-qwen3.5-35b-a3b-nvfp4"

# 完全重建時才用 compose(記得限制記憶體避免 OOM)
$DGX "cd ~/projects/Qwen3.5-35B-A3B && GPU_MEMORY_UTILIZATION=0.45 docker compose up -d"

# 停止(要讓 GPU 給訓練用時)
$DGX "docker stop vllm-qwen3.5-35b-a3b-nvfp4"
```

**⚠ qwen 的兩個必知坑:**
1. **程式別寫死模型名** —— 用 `/v1/models` 查(筆電 `brain.py` 的 `_detect_model()` 已這樣做),換模型才不會 404。
2. **一定要關思考模式**:請求要加 `"chat_template_kwargs": {"enable_thinking": false}`,否則它把 token 全花在「想」,回覆是空的。

---

## 5. YOLO 訓練 — 完整流程

### 5-1. 訓練環境(Docker 映像)

- 映像:**`yolo11-spark:latest`**(20.2GB,DGX 上已建好)。內含 PyTorch 2.10 + CUDA + ultralytics,是專為 GB10(ARM)建的 —— **別在 DGX 主機直接 pip 裝 torch**。
- 若映像不見了要重建:Dockerfile 在筆電專案 `block-vision\docker\Dockerfile`,DGX 上 build context 在 `~/yolo11-docker/`。

### 5-2. 一鍵訓練(建議走這條)

筆電上(Git Bash):

```bash
cd "/d/Documents/ThorWorkSpace/Minecraft 幫手製作/block-vision"
bash tools/push_and_train.sh <run名稱> [暖啟動模型路徑]
# 例:bash tools/push_and_train.sh all_r3 /work/runs/all_r2/weights/best.pt
```

它會自動做四件事:合併資料(`tools/42_merge_single.py`)→ tar 打包 → scp 推上 DGX `~/mc-yolo-all/` → 在 DGX 開 `yolo_train` 容器背景訓練。

### 5-3. 手動版(理解原理 / 客製參數用)

```bash
$DGX "docker run -d --gpus all --shm-size=8g -v ~/mc-yolo-all:/work --name yolo_train \
  yolo11-spark:latest \
  yolo detect train model=/work/runs/all/weights/best.pt data=/work/data.yaml \
  epochs=60 imgsz=640 batch=16 patience=12 project=/work/runs name=<run名> exist_ok=True"
```

- `model=...best.pt` = 暖啟動(接著上一輪練);從零用 `model=yolo11s.pt`。
- `--shm-size=8g` 必加,不然 DataLoader 會掛。

### 5-4. 看進度、抓回模型

```bash
# 看進度
$DGX "docker logs --tail 5 yolo_train"
$DGX "tail -2 ~/mc-yolo-all/runs/<run名>/results.csv"

# 訓完抓回筆電(先備份舊模型!)
scp -i ~/.ssh/dgx_claude "ethan@192.168.0.126:~/mc-yolo-all/runs/<run名>/weights/best.pt" \
    "/d/Documents/ThorWorkSpace/Minecraft 幫手製作/block-vision/model/all_yolo11s.pt"
```

### 5-5. ⭐ 訓練前後的固定儀式

1. **訓練前:先停 qwen**(GPU 記憶體不夠兩個一起跑):
   `$DGX "docker stop vllm-qwen3.5-35b-a3b-nvfp4"`
2. 跑訓練(上面 5-2 或 5-3)。
3. **訓完:把 qwen 開回來**:
   `$DGX "docker start vllm-qwen3.5-35b-a3b-nvfp4"`

---

## 6. DGX 上的目錄地圖

| DGX 路徑 | 是什麼 |
|---|---|
| `~/mc-yolo-all/` | 主 YOLO 資料集(127類)+ `runs/` 訓練輸出 |
| `~/mc-yolo-all/runs/<run名>/` | 每輪訓練:`results.csv` + `weights/best.pt` |
| `~/mc-yolo-{v2,v3,multi}/` | 歷代舊訓練(記錄已抓回筆電 `訓練素材\_訓練記錄_DGX\`) |
| `~/projects/Qwen3.5-35B-A3B/` | qwen 大腦的 docker compose 專案 |
| `~/yolo11-docker/` | yolo11-spark 映像的 build context |
| `~/minecraft-brain/` | 舊 gemma 大腦(已停用,換成 qwen) |

## 7. 筆電端相關檔案(對照用)

| 筆電路徑(專案根 = `D:\Documents\ThorWorkSpace\Minecraft 幫手製作`) | 是什麼 |
|---|---|
| `block-vision\tools\push_and_train.sh` | 一鍵推資料+訓練 |
| `block-vision\tools\42_merge_single.py` | 合併資料進 yolo_all |
| `block-vision\model\` | 訓好抓回來的模型(bot 實際載入這裡) |
| `block-vision\docker\` | yolo11-spark 的 Dockerfile |
| `block-vision\docs\訓練完整流程.md` | 訓練原理逐步解說(教學版) |
| `block-vision\docs\Docker容器_DGX訓練環境.md` | Docker 環境細節 |
| `minecraft-bot\brain.py` | 連 DGX qwen 的大腦客戶端 |
| `web-chat\control_server.py` | 手機遙控面板(埠 8777,也連 qwen) |

---

## 8. 踩過的坑總表(新 AI 必讀)

1. **ARM 架構**:DGX 是 aarch64,x86 的 wheel 裝不上。一律用 NGC 容器(`nvcr.io/nvidia/pytorch:26.01-py3` 系列)。
2. **base python3 沒有 torch**:主機環境是乾淨的,所有訓練都進 Docker。
3. **GPU 記憶體只有一份**(統一記憶體):qwen 和訓練不能同時吃滿 → 訓練前停 qwen(見 5-5)。
4. **qwen 思考模式**:不關的話回覆全空(見第 4 節)。
5. **DataLoader 錯誤**:訓練容器要 `--shm-size=8g`(必要時再加 `workers=0`)。
6. **記憶體幽靈**:若 DGX 記憶體莫名不足(幾十 GB 沒人用卻佔著),最徹底解法是重開機 DGX。
7. **私鑰安全**:`dgx_claude` 私鑰不進 git、不上雲端、不貼對話。密碼同理。
