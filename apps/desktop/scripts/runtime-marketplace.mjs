/** Build reviewed, self-contained marketplace artifacts from repository-owned source. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const reviewed = [
  { id: 'focus-timer', title: 'Focus Timer',
    en: {
      summary: 'Keep a simple focus countdown beside your conversation.',
      accounts: 'No account, model request or network service is needed.',
      access: 'Adds a sidebar panel and saves your preferred duration in local Harness settings. Countdown progress is not saved.',
      setup: 'After restarting, choose Installed → Open timer, or use Focus timer in the sidebar. Enter minutes and start. Closing the panel keeps it running; reloading or quitting clears the countdown. No sound or system notification is sent.',
    },
    ar: {
      summary: 'شغّل عدّاد تركيز بسيط جنب المحادثة.',
      accounts: 'مش محتاج حساب ومش بيستخدم نموذج أو خدمة شبكة.',
      access: 'بيضيف لوحة جانبية وبيحفظ المدة المفضلة في الإعدادات المحلية. تقدم العدّاد مش بيتحفظ.',
      setup: 'بعد إعادة التشغيل افتح المثبّت ← افتح المؤقت، أو اضغط مؤقت التركيز في الشريط الجانبي. اكتب الدقايق وابدأ. قفل اللوحة مش بيوقف العدّاد، لكن التحديث أو الخروج بيمسحه. مفيش صوت أو إشعارات نظام.',
    },
  },
  { id: 'notification-controls', title: 'Notification Controls',
    en: {
      summary: 'Choose whether desktop tasks notify you when they finish or fail.',
      accounts: 'The controls need no account and do not run model tasks.',
      access: 'Saves notification preferences in local Harness settings and filters the desktop task-notification policy. It does not grant OS notification permission.',
      setup: 'After restarting, open Installed → Configure notifications. Both switches initially allow notifications. The app must be in the background and have OS permission. To silence notifications, turn off the switches; removing this Bundle restores the default notification behavior.',
    },
    ar: {
      summary: 'اختار توصلك إشعارات لما المهمة تخلص أو تفشل.',
      accounts: 'المفاتيح مش محتاجة حساب ومش بتشغّل مهمة نموذج.',
      access: 'بيحفظ تفضيلات الإشعارات محليًا وبيتحكم في إشعارات المهام. مش بيدي إذن إشعارات نظام التشغيل.',
      setup: 'بعد إعادة التشغيل افتح المثبّت ← إعداد الإشعارات. المفتاحين بيسمحوا بالإشعارات افتراضيًا. لازم التطبيق يكون في الخلفية ومعاه إذن النظام. اقفل المفاتيح عشان تسكت الإشعارات. إزالة الحزمة بترجع السلوك الافتراضي.',
    },
  },
  { id: 'delegation-launcher', title: 'Delegate Tasks',
    en: {
      summary: 'Submit work to a loaded agent provider, then read or cancel its task.',
      accounts: 'Providers need their own setup or login. Execution and automatic parent-model completion handling may consume account quota. Installing or browsing does not run a model task.',
      access: 'Uses the selected session and workspace. The chosen provider may read or modify files, run commands and inherit conversation context according to its configuration. Task input and outcomes are logged.',
      setup: 'After restarting, open a session and choose Installed → Delegate a task. Choose a loaded provider, enter the task and confirm access before submitting. Read result collects finished output; Cancel task requests cancellation. This Bundle does not install or authenticate providers.',
    },
    ar: {
      summary: 'ابعت شغل لموفّر وكيل محمّل، وبعدين اقرأ النتيجة أو الغي المهمة.',
      accounts: 'الموفّرين محتاجين إعداد أو تسجيل دخول منفصل. تنفيذ المهمة ومعالجة نتيجتها تلقائيًا ممكن يستهلكوا حصة الحساب. التثبيت والتصفح مش بيشغّلوا مهمة نموذج.',
      access: 'بيستخدم المحادثة ومساحة العمل المختارة. الموفّر ممكن يقرأ أو يعدّل ملفات، يشغّل أوامر، أو يرث سياق المحادثة حسب إعداداته. المدخلات والنتائج بتتسجل.',
      setup: 'بعد إعادة التشغيل افتح محادثة واختار المثبّت ← فوّض مهمة. اختار موفّر محمّل، اكتب المهمة وأكد الوصول قبل الإرسال. اقرأ النتيجة بيجمع المخرجات النهائية، والغِ المهمة بيطلب الإلغاء. الحزمة مش بتثبّت الموفّرين ولا بتسجّل دخولهم.',
    },
  },
]

/**
 * Pack reviewed source with pinned pnpm, then atomically publish catalog metadata after the artifact.
 * Old content-addressed artifacts stay available to a running development host.
 * @param {string} output - caller-owned generated catalog directory.
 * @param {string} node - build host Node executable.
 * @param {string} manager - pinned pnpm entry.
 * @param {string} platform - reviewed target operating system.
 * @param {string} arch - reviewed target architecture.
 * @returns {Promise<void>} after the catalog and verified byte identity are published.
 */
export async function prepareMarketplace(output, node, manager, platform, arch) {
  const harness = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await mkdir(output, { recursive: true })
  const staging = await mkdtemp(join(output, '.pack-'))
  try {
    const entries = []
    for (const review of reviewed) {
      const packageDir = join(root, 'packages/desktop', review.id)
      const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
      if (manifest.name !== `@deepseek-ai/dsh-${review.id}` || manifest.version !== harness.version) {
        throw new Error(`${review.id} must match the reviewed Harness version and package identity`)
      }
      if (typeof manifest.license !== 'string' || manifest.license.trim() === '') {
        throw new Error(`${review.id} must declare a Bundle license`)
      }
      for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
        if ((await readFile(join(packageDir, file))).length === 0) throw new Error(`${review.id} build output is empty: ${file}`)
      }
      const packDirectory = join(staging, review.id)
      await mkdir(packDirectory)
      const artifact = await pack(packageDir, packDirectory, node, manager)
      const bytes = await readFile(artifact)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const file = `${review.id}-${sha256}.tgz`
      await rename(artifact, join(output, file))
      entries.push({
        id: review.id, title: review.title, packageName: manifest.name, version: manifest.version,
        publisher: 'Harness Desktop', source: 'https://github.com/Bestbbb/deepseek-harness-desktop',
        details: { license: manifest.license, en: review.en, ar: review.ar },
        harnessVersions: [harness.version], platforms: [`${platform}-${arch}`], artifact: { file, sha256, size: bytes.length },
      })
    }
    const pending = join(staging, 'catalog.json')
    await writeFile(pending, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, { flag: 'wx' })
    await rename(pending, join(output, 'catalog.json'))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Pack one reviewed package and reject incomplete output before catalog publication. */
async function pack(packageDir, staging, node, manager) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/iu.test(key)))
  await new Promise((resolvePack, reject) => {
    // pack follows the declared bundled dependencies without changing the workspace install layout.
    const child = spawn(node, [manager, 'pack', '--config.node-linker=hoisted', '--pack-destination', staging], {
      cwd: packageDir, stdio: 'ignore', env: { ...env, npm_config_ignore_scripts: 'true', npm_config_manage_package_manager_versions: 'false' },
    })
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60_000)
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      if (code === 0 && signal === null && !timedOut) resolvePack()
      else reject(new Error(`Reviewed Bundle packaging failed (${code ?? signal})`))
    })
  })
  const files = (await readdir(staging)).filter(file => file.endsWith('.tgz'))
  if (files.length !== 1) throw new Error('Reviewed Bundle packaging must produce one tarball')
  return join(staging, files[0])
}
