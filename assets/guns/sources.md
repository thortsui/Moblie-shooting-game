# 槍枝圖片來源與授權（assets/guns/）

第三輪（2026-07-14）：前兩輪（軍人持槍新聞照→側面棚拍照）均不符「第一人稱持槍視角」驗收標準，全數棄用。
本輪改用 **CC0 3D 模型 + Blender 自渲染**：相機擺在槍尾後上方（FPS 視角），槍口朝畫面上方遠處，透明背景渲染，5 把同一素材包、風格完全一致。

## 素材來源（5 把共用同一包）

- **素材包**：Ultimate Gun Pack（July 2019）
- **作者**：Quaternius（quaternius.com）
- **授權**：**CC0**（Creative Commons Zero / Public Domain Dedication）——可自由免費使用於任何用途，不需署名（仍記錄作者備查）
- **下載頁**：https://opengameart.org/content/low-poly-guns-pack
- **原始檔**：https://opengameart.org/sites/default/files/ultimate_gun_pack_by_quaternius.zip
- **下載日期**：2026-07-14
- **原始檔存放**：`assets/guns_raw/quaternius/`（已 gitignore）

## 各檔案對應模型

| 輸出檔 | 使用模型（.blend） | 內容 | 尺寸 |
|---|---|---|---|
| pistol.png | Pistol_1 | 半自動手槍，正後上方視角（同 gun.png 構圖） | 515×520 |
| rifle.png | AssaultRifle_1 | AK 風格突擊步槍（木質護木+戰術導軌） | 520×420 |
| smg.png | SubmachineGun_2 | 衝鋒槍（頂部導軌+長彈匣+摺疊骨架托） | 520×421 |
| shotgun.png | Shotgun_1 | 泵動式散彈槍（雙管膛+擊錘） | 520×362 |
| sniper.png | SniperRifle_1 | 栓式狙擊槍（大型瞄準鏡+槍機拉柄） | 520×328 |

## 第四輪補充（2026-07-14）：rocket.png

Ultimate Gun Pack 內無火箭筒/榴彈發射器類模型（已逐檔清查），改用同作者（Quaternius）另一 CC0 模型，走同一 blender-mcp 渲染管線，低多邊形平塗風格一致。

- **模型**：Rocket Launcher（.glb，紅/灰/黑平塗，管口有雙火箭彈頭、尾部排焰喇叭口）
- **作者**：Quaternius（quaternius.com）
- **授權**：**CC0**（Creative Commons Zero 1.0，免署名，仍記錄作者備查）
- **下載頁**：https://poly.pizza/m/GCqUvqleqN
- **原始檔**：https://static.poly.pizza/4b445cbf-38b6-43f3-afd6-32d88e8f074b.glb
- **下載日期**：2026-07-14
- **原始檔存放**：`assets/guns_raw/quaternius_polypizza/RocketLauncher_Quaternius.glb`

| 輸出檔 | 使用模型 | 內容 | 尺寸 |
|---|---|---|---|
| rocket.png | Rocket Launcher（poly.pizza `GCqUvqleqN`） | 火箭筒 FPS 視角：尾部排焰喇叭口在右下近處朝觀者、砲口（紅色火箭彈尖）指向左上遠方，砲口尖端置中對齊圖頂 | 520×363 |

## 渲染管線（2026-07-14，本機 Blender 4.2 + blender-mcp）

1. 從 .blend append 模型（保留原始平塗材質；槍口朝 +X）。
2. FPS 相機：槍尾後上方偏左（+Y 側），鏡頭 32mm，沿槍管向前俯視——畫面中槍托在右下近處、槍口指向左上遠方（狙擊槍相機較低，讓槍口高於鏡筒）。
3. EEVEE Next、透明底片（film_transparent）、白色世界光+太陽光，1400×1650 渲染。
4. 後製（Pillow）：裁透明邊界 → 水平補透明邊讓「槍口尖端」位於圖片頂端水平正中（對齊遊戲 #muzzleFlash 在圖片頂端中央的火光）→ 長邊縮至 520 → RGBA PNG。
   - 槍口偵測：頂部 60 行內「最左側像素群集」質心（槍都指向左上；狙擊鏡上緣可能比槍口更高、但一定在更右側）。
5. 槍托/托架貼齊畫框右下邊緣屬刻意構圖（如同 FPS 遊戲中槍身延伸出畫面）。

## 授權整理

| 檔案 | 授權 | 是否需署名 |
|---|---|---|
| pistol.png / rifle.png / smg.png / shotgun.png / sniper.png | CC0（Quaternius Ultimate Gun Pack 之自製渲染） | 否 |
| rocket.png | CC0（Quaternius「Rocket Launcher」poly.pizza 模型之自製渲染） | 否 |

## 歷史紀錄（備查，均已棄用）

- 第一輪（2026-07-14 前）：美軍軍人持槍新聞照（PD），去背後主體是人不是槍，棄用。
- 第二輪（2026-07-14 稍早）：Wikimedia 純槍側面棚拍照（Crime2.jpg CC0 / PEO M4 PD / MP5A3 PD等效 / Mossberg 590 PD / XM2010 PD），視角是側面圖不符第一人稱驗收，棄用；原始檔仍在 `assets/guns_raw/`。
- OpenGameArt「FPS Weapon Sprites」(Ragnar Random, CC0)：真 FPS 視角但僅有手槍/散彈槍且為手繪 cel-shaded 低解析風，湊不齊 5 把，未採用。
- OpenGameArt「FPS Weapons Overlay」(CC0)：Wolfenstein 風像素圖 2.5KB，解析度過低，未採用。
