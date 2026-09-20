/** Egyptian Arabic copy for the lecture-choice strip and its composer text. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Lecture-choice strip copy. */
    transcriberComposer: TranscriberComposerKey
  }
}

/** The external locale selected by the medical-study surface. */
export const ARABIC_LOCALE = 'ar-EG'

/** Simplified Chinese dictionary slot; this feature deliberately keeps its copy Arabic. */
export const zh = {
  title: 'مساعد المحاضرات',
  'module.label': 'الموديول',
  'module.placeholder': 'اختار الموديول',
  'lecture.label': 'المحاضرة',
  'lecture.placeholder': 'اختار المحاضرة',
  'status.transcribed': 'متفرغة',
  'status.waiting': 'مستنية التفريغ',
  'action.label': 'اختار هتعمل إيه',
  'action.transcribe': 'فرّغ المحاضرة',
  'action.review': 'راجع المسودة',
  'action.audit': 'راجع مصادر الموديول',
  'action.readiness': 'اتأكد من جاهزية الموديول',
  'source.label': 'ملفات المحاضرة',
  loading: 'بنشوف الموديولات والمحاضرات…',
  'empty.modules': 'مفيش موديولات في مساحة المذاكرة لسه. اطلب من الشات يعمل موديول.',
  'empty.lectures': 'الموديول ده مفيهوش تسجيلات لسه. حط التسجيلات في مجلد Lecture.',
  'error.read': 'مش قادرين نقرأ مساحة المذاكرة: {message}',
  'strip.aria': 'اختيارات المحاضرات',
  'actions.aria': 'اختيارات الطلب',
} satisfies Record<string, string>

/** The strip's key union. */
export type TranscriberComposerKey = keyof typeof zh

/** English dictionary slot; the strip remains Egyptian Arabic in every shipped client locale. */
export const en = zh satisfies Record<TranscriberComposerKey, string>

/** Arabic additions to the existing Conversation namespace without changing ui-conversation. */
export const conversationArabic = {
  'hint.plan': 'اكتب اللي عايز تعمله عشان نجهز خطة',
  'hint.goal': 'اكتب الهدف، والمساعد هيفضل ينفذه',
  'hint.goal.active': 'فيه هدف شغال — عدّل أو وقّف أو كمّل أو امسحه',
  'placeholder.plan': 'اكتب اللي عايز تعمله عشان نجهز خطة',
  'placeholder.default': 'اكتب رسالتك أو المهمة، أو استخدم / للأوامر و@ للملفات أو الجلسات',
  'placeholder.unavailable': 'الجلسة مش متاحة',
  'placeholder.parentOffline': 'الجلسة الأصلية مش متاحة؛ الإرسال متوقف لكن تقدر توقف التشغيل',
  'placeholder.hero': 'اكتب عايز تبني إيه، أو استخدم / للأوامر و@ للملفات أو الجلسات',
  'placeholder.workspace': 'اختار مساحة مذاكرة عشان تبدأ',
  'placeholder.steerQueue': 'Cmd/Ctrl+Enter يبعث كل الرسائل المستنية للمساعد',
  'input.commands': 'الأوامر',
  'input.stop': 'وقف التوليد',
  'input.send': 'ابعت الرسالة',
  'input.send.queue': 'حط الرسالة في الانتظار',
  'input.send.steer': 'ابعت الرسالة دلوقتي',
  'input.accessMode': 'وضع الصلاحيات، الحالي: {name}',
  'file.attach': 'ضيف ملف',
  'file.stillUploading': 'الملفات لسه بتترفع؛ ابعت بعد ما تخلص',
  'hero.chooseWorkspace': 'اختار مساحة مذاكرة',
  'context.aria': 'استخدمت {percent} من السياق',
  'context.used': 'من السياق مستخدم',
  'context.system': 'تعليمات النظام',
  'context.tools': 'تعريفات الأدوات',
  'context.messages': 'الرسائل',
  'access.preset.readOnly': 'قراءة فقط',
  'access.preset.workspaceWrite': 'تعديل مساحة المذاكرة',
  'access.preset.fullAccess': 'صلاحيات كاملة',
  'access.confirm.title': 'تفعّل الصلاحيات الكاملة؟',
  'access.confirm.description': 'الصلاحيات الكاملة بتقلل خطوات التأكيد وبتسمح للمساعد ينفذ عمليات حساسة ويعدّل الملفات أو يشغل أوامر خارجية. فعّلها بس لو واثق في المهمة الحالية.',
  'access.confirm.acknowledge': 'فاهم المخاطر وعايز أكمل',
  'access.confirm.cancel': 'إلغاء',
  'access.confirm.enable': 'فعّل الصلاحيات الكاملة',
} satisfies Record<string, string>
