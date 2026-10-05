---
description: "قَبَس تطبيق دراسة لطلاب الطب يجمع التسجيلات والشرائح والامتحانات السابقة ويحوّل المحاضرات إلى تفريغات منظمة."
---

# قَبَس — Qabas

قَبَس تطبيق سطح مكتب بواجهة عربية لطلاب الطب. يجمع موادك في مكتبة دراسة، ويأخذ كلام الدكتور بالحرف ليبني منه شرحًا منظمًا وأسئلة للمراجعة. الاسم يعني الأخذ من كلام شخص كما قاله.

## ماذا يفعل؟

- ينظم الموديولات ومحاضراتها: التسجيلات والشرائح وأوراق الامتحانات السابقة.
- يبدأ من زر المحاضرة مهمة كاملة دون محادثة: يرفع التسجيلات إلى `NotebookLM`، ويستخرج كلام الدكتور بالحرف، ثم يكتب شرحًا منظمًا باستخدام `Antigravity CLI` (`agy`) و`Gemini` على حسابك في Google.
- يستخرج صور الشرائح، ويمكنه إضافة رسوم توضيحية من `Wikimedia Commons` عند تفعيل خيار الصور الخارجية في الإعدادات.
- يبني أسئلة مستندة إلى امتحانات الموديول السابقة، ويتحقق من التفريغ ويحفظه ويحدّث `Index.md`.
- يتيح متابعة المهام أو إعادتها، واستعادة العناصر المحذوفة من سلة المهملات.
- يوفر مساعد محادثة باستخدام `Gemini` ومفتاح API الخاص بك.

## التثبيت على Windows

1. افتح [صفحة إصدارات قَبَس](https://github.com/3omr/qabas/releases)، ونزّل مثبت `Windows x64` بصيغة `.exe` (`NSIS`).
2. شغّل المثبت. لأنه غير موقّع، يعرض `Windows SmartScreen` تحذيرًا؛ اختر `More info` ثم `Run anyway` لإكمال التثبيت.
3. افتح قَبَس وأكمل إعداد الحسابات والأدوات أدناه. لا تحتاج إلى أدوات بناء التطبيق لتشغيل النسخة المثبتة.

التحديث التلقائي غير مهيأ؛ نزّل الإصدارات الجديدة من صفحة الإصدارات.

## الإعداد لأول مرة

من الإعدادات، افتح «الحسابات والأدوات»:

1. احصل على مفتاح `Gemini API` من [Google AI Studio](https://aistudio.google.com/apikey)، واحفظه في التطبيق لتشغيل مساعد المحادثة.
2. ثبّت `Antigravity CLI` (`agy`) وسجّل الدخول بحساب Google. هذه الأداة مطلوبة لكتابة التفريغ.
3. للوصول إلى `NotebookLM`، ثبّت `Python 3` (الإصدار `3.10` أو أحدث) و`pipx`، ثم نفّذ الأوامر التالية وسجّل الدخول:

```powershell
pipx install notebooklm-mcp-cli
nlm login
```

ثبّت `Poppler` أيضًا؛ أداتا `pdftotext` و`pdfinfo` مطلوبتان لقراءة نصوص PDF وعدّ صفحاتها. وتوفر الحزمة أدوات استخراج صور الشرائح الاختيارية:

```powershell
winget install oschwartz10612.Poppler
```

الأدوات التالية اختيارية بحسب ملفاتك: `LibreOffice` لتحويل شرائح `PPTX` و`DOCX`، و`GhostScript` لضغط ملفات PDF الكبيرة، و`FFmpeg` لتحويل التسجيلات إلى صيغ يقبلها `NotebookLM`:

```powershell
winget install TheDocumentFoundation.LibreOffice
winget install ArtifexSoftware.GhostScript
winget install Gyan.FFmpeg
```

`OCRmyPDF` أداة اختيارية لقراءة أوراق الامتحانات الممسوحة ضوئيًا التي لا تحتوي على طبقة نص؛ تذكر أداة الفحص أنها مضمّنة في حزمة سطح المكتب على Windows.

تعرض شاشة «جهّز أدوات التفريغ» ما ينقصك وأمر تثبيته. ويمكنك مراجعة الحالة لاحقًا في قسم «أدوات على جهازك» ضمن «الحسابات والأدوات».

## أين توجد ملفات الدراسة؟

ينشئ التطبيق مجلد `Qabas Library` داخل مجلد المستخدم، وفيه `modules/` للموديولات. على Windows يكون المسار عادةً `C:\Users\<username>\Qabas Library\modules\`. تحتفظ الموديولات بالتسجيلات والشرائح والامتحانات والتفريغات؛ ويمكن استعادة العناصر المنقولة إلى سلة المهملات من التطبيق.

تفاصيل المعالجة وإدارة الملفات في [دليل محرك قَبَس](engine/README.md).

<a id="run-from-source"></a>

## البناء من المصدر على Windows

هذا القسم للمطورين. ثبّت `Node.js 22.19+` من سلسلة `22.x` أو `24+`، و`pnpm 11.7`، و`Rust stable`، و`Python 3.12`. تحتاج أيضًا إلى متطلبات `Tauri 2`: أدوات `Visual Studio Build Tools` مع حزمة C++ و`WebView2`.

من جذر المستودع، نفّذ:

```powershell
pnpm install --frozen-lockfile
python -m pip install -r engine/requirements-build.txt
pnpm run engine:build
pnpm run desktop:build
```

يستدعي `engine:build` أداة `bash`؛ شغّله من بيئة توفرها، مثل `Git Bash`. يوجد المثبت الناتج في `apps/desktop/src-tauri/target/release/bundle/nsis/`. راجع [دليل سطح المكتب](apps/desktop/README.md) و[دليل المحرك](engine/README.md) للتفاصيل.

للتشغيل من المصدر دون نافذة سطح المكتب على أي نظام، جهّز البيئة `engine/.venv` وفعّلها وفق [دليل المحرك](engine/README.md)، ثم نفّذ:

```sh
pnpm dsh --profile web --patch engine/transcriber.cordis.yml
```

## المصدر والترخيص

[قَبَس](https://github.com/3omr/qabas) مبني على [توزيعة سطح المكتب المجتمعية باستخدام Tauri](https://github.com/Bestbbb/deepseek-harness-desktop)، المبنية بدورها على [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

الترخيص [MIT](LICENSE). تراخيص المكونات الأخرى موضحة في [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
