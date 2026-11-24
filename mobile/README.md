# RUKH native apps (Capacitor 8)

`biz.mmix.rukh`, store name "RUKH Dance Battle" (listing title in `../store/listing.json`), home-screen name "RUKH".
The whole web app from `../public` is bundled on the device (`scripts/sync-web.sh` → `www/`, demo videos left out);
the start page is `public/app.html`. Network calls go to https://rukh.mmix.biz through `public/js/env.js`
(`IS_APP`, `ORIGIN`, `WS_ORIGIN`). `web/native.js` is injected into every bundled page: keep-awake on all pages
except the start screen, Android back button, clean paths (`/cam` → `/cam.html`). Plugins only through
`window.Capacitor.Plugins[name]`.

Android
- `bash scripts/android-build.sh bundle` → `android/app/build/outputs/bundle/release/app-release.aab` (Play upload)
- `bash scripts/android-build.sh apk` → release APK for redroid (`adb connect 127.0.0.1:5599`)
- version: `RUKH_VERSION_CODE=2 RUKH_VERSION_NAME=1.0.1 bash scripts/android-build.sh bundle` (bump the code for every Play upload)
- upload key: `~/.config/rukh-app/upload.jks` + `upload.properties` (backup `/data/backups/rukh/`), SHA-256
  `1C:E1:5C:F7:AC:B5:3E:7B:3D:E6:2C:81:BA:CB:EE:96:9B:F7:8E:7C:0D:5D:AE:6B:0E:1B:59:A4:B8:B4:49:B9`
- permissions: INTERNET, CAMERA (camera feature optional so camera-less tablets can be the TV)
- WebView console: build `debug`, `adb forward tcp:9339 localabstract:webview_devtools_remote_<pid>`, then CDP

iOS (GitHub Actions, repo ctmakc/rukh, workflow `.github/workflows/ios.yml`, manual)
- `gh workflow run ios.yml -R ctmakc/rukh --ref <branch> -f upload=false` → signed IPA artifact
- bundle id + profile "RUKH App Store": `store/tools/asc_profile.py` (team 6W4Q86TQ96, Finman's distribution cert)
- secrets in the repo: IOS_P12_BASE64, IOS_P12_PASSWORD, IOS_PROFILE_BASE64, ASC_KEY_P8, ASC_KEY_ID, ASC_ISSUER_ID
- store: `store/IOS-OWNER-STEP.md` (one browser step), then `bash store/tools/ios_publish.sh`

Icons and store art
- source SVGs in `assets-src/` (tape R mark); `npx capacitor-assets generate --iconBackgroundColor '#141519' --splashBackgroundColor '#141519'`
- `store/icon-play-512.png`, `store/icon-ios-1024.png` (RGB, no alpha), `store/feature-graphic-1024x500.png`
- screenshots: `node store/tools/make_shots.mjs <camera.y4m>` → `store/screenshots/{apple-6.7,apple-6.5,play-phone}`
