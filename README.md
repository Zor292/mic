# VoiceLink Roblox Proximity Voice

نظام فويس شات خارجي يعتمد على WebRTC ويربط الصوت بمواقع اللاعبين داخل سيرفر Roblox.

## التشغيل

1. ثبّت Node.js 18 أو أحدث.
2. داخل مجلد المشروع نفّذ `npm install`.
3. شغّل الخادم:

```powershell
$env:ROBLOX_API_KEY="ضع-مفتاحًا-طويلًا-هنا"
$env:PUBLIC_URL="https://your-domain.example"
npm start
```

4. استخدم HTTPS في الاستضافة النهائية لأن المتصفح يمنع الميكروفون على HTTP خارج localhost.
5. افتح `VoiceLinkPlace.rbxlx` في Roblox Studio.
6. في Explorer افتح `ServerScriptService > VoiceChatServer` واضبط Attributes التالية:
   - `ApiBase`: رابط الخادم بدون `/` في النهاية
   - `ApiKey`: نفس قيمة `ROBLOX_API_KEY`
   - `SiteUrl`: رابط الموقع
7. فعّل `Game Settings > Security > Allow HTTP Requests`.
8. انشر التجربة ثم اختبر دخول لاعبين من نفس السيرفر.

## ما داخل الحزمة

- `server.js`: API، ربط رموز الجلسات، تحديث المواقع، وإشارة WebRTC.
- `public`: موقع الدخول ولوحة الخريطة والأجهزة والصوت.
- `roblox/VoiceChat.server.lua`: إنشاء الرموز وتحديث مواقع اللاعبين.
- `roblox/VoiceChat.client.lua`: تشغيل عناصر الواجهة الفعلية وربط أزرار الموقع والمايك.
- `roblox/VoiceChatGui.rbxmx`: GUI مستقلة بعناصر فعلية للاستيراد المباشر إلى `StarterGui`.
- `VoiceLinkPlace.rbxlx`: Place يحتوي ScreenGui وFrames وTextButtons وTextLabels فعلية داخل Explorer.

## إضافة الواجهة إلى ماب موجود

استورد `roblox/VoiceChatGui.rbxmx` إلى `StarterGui`. يجب أن يكون `VoiceSessionEvent` و`VoiceLinkConfig` داخل `ReplicatedStorage`، وأن يكون `VoiceChat.server.lua` داخل `ServerScriptService`.

تسجيل الدخول في الموقع شكلي فقط؛ لا يتم استخدام Roblox OAuth ولا يتم طلب كلمة المرور.
