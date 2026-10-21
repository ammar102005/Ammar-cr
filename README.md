# Certify Server — الخادم (المرحلة 1: النواة)

تشغيل: `cp .env.example .env` ثم عدّل JWT_SECRET و PUBLIC_URL، ثم `docker compose up --build`  → API على http://localhost:3000

## المسار الكامل (curl)
1. `POST /auth/register {email,password}` → token (ثم `Authorization: Bearer <token>`)
2. `POST /projects {name}` → id
3. `PUT /projects/:id/design {data:<design JSON v1>}` (نفس صيغة محرر النموذج الأولي، تُراجع بـ Zod)
4. `POST /projects/:id/import/preview` (form-data: file) → الأعمدة + اقتراح المطابقة + معاينة
5. `POST /projects/:id/jobs` (form-data: file, mapping='{"name":"الاسم",...}', formats='pdf,png') → jobId + الصفوف المرفوضة وأسبابها
6. `GET /jobs/:id` (تقدم) ، `GET /jobs/:id/files/pdf|zip` (تنزيل بعد التحقق من الملكية)
7. QR يفتح `PUBLIC_URL/v/<token>` (صفحة عامة) ، و `GET /verify/:token` (JSON) ، و `POST /certificates/:id/revoke` للإلغاء

## نقاط تصميم
- التصدير: Chromium/Puppeteer يعرض HTML بالأبعاد نفسها (1123×794) والخطوط مضمّنة (Amiri, Cairo, Tajawal, Playfair, Montserrat) وخوارزمية ملاءمة النص تعمل داخل الصفحة بالخط الفعلي.
- خطأ سجل واحد لا يُسقط الدفعة: تُعاد الدفعة سجلًا سجلًا لعزل الفاشل، ويُسجَّل رقم صفّه في `outputs.failedRows`.
- إعادة المحاولة آمنة: السجلات والرموز تُنشأ في معاملة واحدة عند إنشاء المهمة، والعامل يعيد الرندر فقط (نتائج حتمية).
- ملفات الإخراج تُحذف بعد `RETENTION_DAYS`. التخزين محلي خلف `storage` في `common/infra.ts` — يُستبدل بـ S3 دون لمس بقية الكود.
- **غير منفَّذ بعد:** واجهة Next.js، حدود الخطط والدفع، البريد، حدّ معدّل لتسجيل الدخول، migrations (نستخدم `db push` مؤقتًا)، اختبارات Playwright/Vitest.
