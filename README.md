# screenmate

바탕화면 위에 MMD 캐릭터를 띄우는 데스크톱 메이트. Tauri 2 + Babylon.js + babylon-mmd.
설계와 진행 상황은 [docs/PLAN.md](docs/PLAN.md)에 있다.

## 개발 환경

- Node.js, Rust (stable)
- Windows: Visual Studio Build Tools (C++ 데스크톱 워크로드), WebView2
- macOS: Xcode Command Line Tools

```bash
npm install
npm run tauri dev
```

## 모델

`models/` 아래에 사용 중인 MMD 모델이 readme와 함께 들어 있다. 각 모델의 이용 약관은 해당 폴더의 readme를 따른다.

앱은 모델을 앱 데이터 폴더로 가져와서 쓴다. 처음 실행할 때 한 번 가져오면 된다.

- 트레이 아이콘 → **모델 가져오기…** → `models/` 안의 폴더 선택 (폴더마다 한 번)
- 또는 명령줄로 한 번에 (저장소 루트에서. 앱은 `src-tauri`에서 실행되므로 절대 경로로 넘긴다):

```bash
npx tauri dev -- -- --import "$PWD/models/DIVA風水着セット" "$PWD/models/Sour式鏡音リン・レンVer.2.01" "$PWD/models/YYB式鏡音レンver1.00"
```

앱 데이터 위치: Windows `%APPDATA%\dev.sleeeppy.screenmate`, macOS `~/Library/Application Support/dev.sleeeppy.screenmate`.
모델별 보정값과 덮어쓰기는 그 안의 `profiles/<id>.json`에 있다.
